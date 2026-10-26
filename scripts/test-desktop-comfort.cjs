// Desktop comfort suite (E4): esbuild + vm, no Electron, runs on the ubuntu CI.
// Toast stack, revealPane, in-app agent cards and phone-action notices.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'ws', 'node-pty'], alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, Buffer, URL, setTimeout, clearTimeout, ...overrides })
  return mod.exports
}
// Renderer modules bundled together so they share one store instance.
function loadRenderer(contents, overrides = {}) {
  const code = buildSync({ stdin: { contents, resolveDir: path.join(root, 'src/renderer/lib'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, define: { 'process.env.NODE_ENV': '"production"' } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, crypto: globalThis.crypto, setTimeout, clearTimeout, ...overrides })
  return mod.exports
}

async function main() {
  // --- selectVisible / pruneForPush (pure) ----------------------------------
  {
    const { selectVisible, pruneForPush } = loadRenderer(`export * from './toast'`)
    const mk = (id, createdAt, durationMs = 3000, priority = 0) => ({ id, kind: 'info', title: id, durationMs, priority, createdAt })
    const five = [1, 2, 3, 4, 5].map(n => mk('t' + n, n))
    const sel = selectVisible(five)
    check(sel.visible.length === 4 && sel.overflow === 1, 'five queued toasts show four')
    check(sel.visible.map(t => t.id).join() === 't2,t3,t4,t5', 'visible are the newest, shown oldest first (newest at the bottom)')
    const pruned = pruneForPush(five, 't5')
    check(pruned.length === 4 && !pruned.some(t => t.id === 't1'), 'a fifth non-persistent push evicts the oldest non-persistent')
    const persistent = [1, 2, 3, 4].map(n => mk('e' + n, n, null, 1))
    const withNew = pruneForPush([...persistent, mk('s', 9)], 's')
    check(withNew.length === 5, 'persistent toasts are never evicted, nor the one just pushed')
    const s2 = selectVisible(withNew)
    check(s2.overflow === 1 && s2.visible.every(t => t.id.startsWith('e')), 'errors outrank a plain toast for the visible slots')
    const mixed = pruneForPush([mk('old', 1), ...persistent.slice(0, 3), mk('new', 9)], 'new')
    check(mixed.length === 4 && !mixed.some(t => t.id === 'old'), 'with mixed toasts only the oldest non-persistent leaves')
    const actions = [1, 2, 3, 4, 5, 6].map(n => mk('a' + n, n, null, 2))
    const s3 = selectVisible(actions)
    check(s3.visible.length === 4 && s3.overflow === 2, 'six persistent actions show four and "+2"')
    const prio = selectVisible([mk('update', 1, null, 3), ...actions])
    check(prio.visible.some(t => t.id === 'update') && prio.overflow === 3, 'update/recovery outranks newer actions')
    const order = selectVisible([mk('err', 5, null, 1), mk('act', 1, null, 2), mk('plain', 9), mk('upd', 2, null, 3), mk('x', 10)])
    check(order.visible.map(t => t.id).join() === 'act,upd,err,x' && order.overflow === 1, 'priority picks update > action > error > rest, ties by recency')
    check(selectVisible([]).overflow === 0 && selectVisible([]).visible.length === 0, 'empty stack')
  }

  // --- toast store API --------------------------------------------------------
  {
    const r = loadRenderer(`export * from './toast'`)
    const { toast, useToastStore, isFromToast } = r
    const items = () => useToastStore.getState().items
    toast.success('ok'); toast.info('i'); toast.warning('w'); toast.error('e')
    const byTitle = t => items().find(x => x.title === t)
    check(byTitle('ok').durationMs === 3000 && byTitle('i').durationMs === 3000 && byTitle('w').durationMs === 6000 && byTitle('e').durationMs === null, 'default durations: success/info 3s, warning 6s, error persistent')
    check(byTitle('e').priority === 1 && byTitle('ok').priority === 0, 'error priority 1, rest 0')
    const cardId = toast.card({ fake: 'node' })
    check(items().find(x => x.id === cardId).durationMs === null && items().find(x => x.id === cardId).node.fake === 'node', 'card is persistent and carries its node')
    check(items().length === 4 && !byTitle('ok'), 'a fifth push evicted the oldest non-persistent (success)')
    useToastStore.setState({ items: [] })
    const a = toast.success('Copiado', { dedupeKey: 'copied' })
    const b = toast.success('Copiado', { dedupeKey: 'copied' })
    check(a === b && items().length === 1 && items()[0].rev === 1, 'double copy shows a single toast and restarts its timer (rev)')
    toast.warning('agent', { dedupeKey: 'agent:p', durationMs: null, priority: 2 })
    check(toast.has('agent:p') && items().find(x => x.dedupeKey === 'agent:p').priority === 2, 'options override defaults')
    toast.dismissByKey('agent:p'); check(!toast.has('agent:p'), 'dismissByKey')
    toast.dismiss(a); check(items().length === 0, 'dismiss by id')
    const before = items(); toast.dismiss('missing'); toast.dismissByKey('missing')
    check(items() === before, 'dismissing an unknown toast does not touch the store')
    check(isFromToast({ target: { closest: sel => sel === '[data-toast-root]' ? {} : null } }) && !isFromToast({ target: { closest: () => null } }) && !isFromToast({ target: null }), 'isFromToast detects clicks that start in the stack')
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < 200; i++) toast.info('perf ' + i)
    const perPush = Number(process.hrtime.bigint() - t0) / 1e6 / 200
    check(perPush < 1 && items().length === 4, `toast push stays under 1 ms (${perPush.toFixed(3)} ms)`)
  }

  // --- revealPane + in-app agent cards + phone notices -----------------------
  {
    const raf = []
    const focusCalls = []
    let commandCb = null
    const results = []
    const r = loadRenderer(`
      export { useAppStore } from './store'
      export { revealPane, agentToastKey } from './revealPane'
      export { onAgentStatus, dismissAgentCardsInView } from './agentNotice'
      export { toast, useToastStore } from './toast'
      export { getFocusedPane, getLastFocusedPaneForWorkspace, registerFocuser } from './focus'
      export { remoteNoticeText, initRemoteCommands } from './remoteCommands'
    `, {
      window: { snApi: { config: { save() {} }, pty: { write() {}, killPanes: async ids => ids.length }, remote: { onCommand: cb => { commandCb = cb; return () => {} }, commandResult: res => results.push(res) } } },
      document: { hasFocus: () => true },
      requestAnimationFrame: fn => { raf.push(fn); return raf.length },
      cancelAnimationFrame() {},
    })
    const S = r.useAppStore
    const items = () => r.useToastStore.getState().items
    const runRaf = () => { for (let i = 0; i < 5 && raf.length; i++) raf.splice(0).forEach(fn => fn()) }
    const pane = (id, title) => ({ id, type: 'claude', title, icon: 'terminal' })
    S.setState({
      hydrated: true, activeWorkspaceId: 'wa',
      workspaces: [
        { id: 'wa', name: 'Alpha', cwd: '', panes: [pane('a1', 'Main')] },
        { id: 'wb', name: 'Beta', cwd: '', panes: [pane('b1', 'API'), pane('b2', 'Web')] },
      ],
      mountedWorkspaces: { wa: 'full' }, maximized: { wb: 'b2' }, minimized: { wb: ['b1'] }, paneAttention: { b1: true },
    })
    S.getState().updateSettings({ language: 'es' })
    r.registerFocuser('b1', () => focusCalls.push('b1'))

    // In-app card: done, with [Ir] and a Settings link.
    r.onAgentStatus({ paneId: 'b1', state: 'done', precise: true, notify: true, delivery: 'inApp', provider: 'claude' })
    let card = items().find(t => t.dedupeKey === 'agent:b1')
    check(card && card.kind === 'success' && card.durationMs === 8000, 'done card is an 8 s success')
    check(card.title === 'Claude terminó en Beta / API', 'done card names provider, workspace and console')
    check(card.actions.length === 1 && card.actions[0].label === 'Ir' && card.link.label === 'Ajustes', 'card has [Ir] and the Settings link')
    card.link.run()
    check(S.getState().settingsOpen && S.getState().settingsCategory === 'notifications#inAppWhenFocused', 'Settings link deep-links to the inAppWhenFocused row')
    S.setState({ settingsOpen: false, settingsCategory: null })

    // [Ir] -> revealPane (E5-FR-04 steps).
    card.actions[0].run()
    const st = S.getState()
    check(st.activeWorkspaceId === 'wb' && st.mountedWorkspaces.wb === 'full', 'revealPane mounts and activates the workspace')
    check(st.maximized.wb === null && !(st.minimized.wb ?? []).includes('b1'), 'revealPane drops a foreign maximize and restores the pane')
    check(!('b1' in st.paneAttention), 'revealPane clears attention')
    check(r.getFocusedPane() === 'b1' && r.getLastFocusedPaneForWorkspace('wb') === 'b1', 'revealPane records the focused pane first (WorkspaceHost lands on it)')
    check(!items().some(t => t.dedupeKey === 'agent:b1'), '[Ir] closes the card')
    runRaf()
    check(focusCalls.includes('b1'), 'revealPane focuses the terminal once mounted')
    check(r.revealPane('ghost') === false, 'revealPane of a deleted pane is a no-op returning false')

    // action: persistent warning, priority 2, closes when the pane leaves the state.
    S.getState().setActive('wa')
    r.onAgentStatus({ paneId: 'b2', state: 'action', precise: true, notify: true, delivery: 'inApp', provider: 'codex' })
    card = items().find(t => t.dedupeKey === 'agent:b2')
    check(card.kind === 'warning' && card.durationMs === null && card.priority === 2 && card.title === 'Codex necesita tu respuesta en Beta / Web', 'action card is a persistent priority-2 warning')
    r.onAgentStatus({ paneId: 'b2', state: 'action', precise: true, notify: false, provider: 'codex' })
    check(items().some(t => t.dedupeKey === 'agent:b2'), 'a same-state update keeps the card')
    r.onAgentStatus({ paneId: 'b2', state: 'working', precise: true, notify: false, provider: 'codex' })
    check(!items().some(t => t.dedupeKey === 'agent:b2'), 'answering in the console (state leaves action) closes the card')
    // v2.3: an answer from any device flips attention to false while the state stays action.
    r.onAgentStatus({ paneId: 'b2', state: 'action', precise: true, notify: true, delivery: 'inApp', provider: 'codex', attention: true })
    r.onAgentStatus({ paneId: 'b2', state: 'action', precise: true, notify: false, provider: 'codex', attention: true })
    check(items().some(t => t.dedupeKey === 'agent:b2'), 'attention true keeps the card')
    r.onAgentStatus({ paneId: 'b2', state: 'action', precise: true, notify: false, provider: 'codex', attention: false })
    check(!items().some(t => t.dedupeKey === 'agent:b2'), 'the same state with attention false (answered on the phone) closes the card')
    r.onAgentStatus({ paneId: 'b2', state: 'action', precise: false, notify: true, delivery: 'inApp', provider: 'claude' })
    check(items().find(t => t.dedupeKey === 'agent:b2').title === 'Claude se detuvo en Beta / Web, revisá la consola', 'an approximate (title-only) stop gets the generic copy, like the native notification')
    r.onAgentStatus({ paneId: 'b2', state: 'working', precise: false, notify: false, provider: 'claude' })

    // error card, native delivery, view dismissal.
    r.onAgentStatus({ paneId: 'b2', state: 'error', precise: true, notify: true, delivery: 'inApp', provider: 'claude' })
    check(items().find(t => t.dedupeKey === 'agent:b2').kind === 'error', 'error card is a persistent error')
    r.dismissAgentCardsInView(['b2'])
    check(!items().some(t => t.dedupeKey === 'agent:b2'), 'a console that comes into view closes its card')
    r.onAgentStatus({ paneId: 'b2', state: 'done', precise: true, notify: true, delivery: 'native', provider: 'claude' })
    r.onAgentStatus({ paneId: 'b2', state: 'done', precise: true, notify: false, delivery: 'none', provider: 'claude' })
    check(!items().some(t => t.dedupeKey === 'agent:b2'), 'native / none delivery shows no card')
    r.onAgentStatus({ paneId: 'b2', state: 'done', precise: true, notify: true, delivery: 'inApp', provider: 'claude' })
    S.getState().setPaneStatus({ paneId: 'x', state: 'idle', precise: false, notify: false })
    r.revealPane('b2')
    check(!items().some(t => t.dedupeKey === 'agent:b2'), 'revealing the pane by another path closes its card')

    // Phone notices (E4-FR-08).
    const gp = { kind: 'globalPrompt', workspaceId: 'wb', text: 'hola' }
    check(r.remoteNoticeText(gp, { ok: true, info: 3 }, 'Pixel', undefined, 'es') === 'Desde Pixel: prompt insertado en 3 consolas', 'global prompt from a named phone')
    check(r.remoteNoticeText(gp, { ok: true, info: 1 }, undefined, undefined, 'es') === 'Desde el celular: prompt insertado en 1 consola', 'singular, and the fallback without a device name')
    check(r.remoteNoticeText(gp, { ok: true, info: 0 }, '  ', undefined, 'en') === 'From the phone: no active console received the prompt', 'zero consoles, blank name falls back (en)')
    check(r.remoteNoticeText({ kind: 'restartPane', workspaceId: 'wb', paneId: 'b1' }, { ok: true }, 'Pixel', 'API', 'es') === 'Desde Pixel: consola "API" reiniciada', 'restartPane notice')
    check(r.remoteNoticeText({ kind: 'closePane', workspaceId: 'wb', paneId: 'b1' }, { ok: true }, 'Pixel', 'API', 'en') === 'From Pixel: console "API" closed', 'closePane notice')
    check(r.remoteNoticeText(gp, { ok: false, error: 'not_found' }, 'Pixel', undefined, 'es') === null && r.remoteNoticeText({ kind: 'setTheme', theme: 'light' }, { ok: true }, 'Pixel', undefined, 'es') === null, 'failed actions and other kinds show nothing')

    r.initRemoteCommands()
    r.useToastStore.setState({ items: [] })
    commandCb({ id: 'c1', action: { kind: 'closePane', workspaceId: 'wb', paneId: 'b2' }, deviceName: 'Pixel' })
    check(results.at(-1).ok && !S.getState().workspaces[1].panes.some(p => p.id === 'b2'), 'closePane ran')
    check(items().at(-1).kind === 'info' && items().at(-1).title === 'Desde Pixel: consola "Web" cerrada', 'closePane from the phone shows the title read before removal')
  }

  // --- SessionManager: deviceName from the session, never from the payload ---
  {
    const { PROTOCOL_VERSION } = load('src/shared/remote-protocol.ts')
    const { SessionManager } = load('src/main/remote/SessionManager.ts', { setInterval: () => 0, clearInterval() {} })
    const calls = []
    const sm = new SessionManager({
      registry: { get: id => (id === 'dev-1' ? { id, name: 'Pixel', secret: 'x' } : undefined), touchLastSeen() {} },
      executeCommand: async (action, deviceName) => { calls.push({ action, deviceName }); return { id: '', ok: true, info: 2 } },
      onConnectionsChanged() {},
    })
    const frames = []
    const session = (deviceId) => ({ ws: { readyState: 1, send: s => frames.push(JSON.parse(s)), bufferedAmount: 0 }, ip: '127.0.0.1', authed: true, deviceId, subs: new Set(), outBuf: new Map(), outTimer: null, congested: new Set(), congestedSince: new Map(), lastSeen: Date.now(), badMsgStrikes: 0 })
    const forged = { v: PROTOCOL_VERSION, type: 'ctl', id: 'k1', deviceName: 'Fake', action: { kind: 'globalPrompt', workspaceId: 'w', text: 'hi', deviceName: 'Fake' } }
    await sm.onMessage(session('dev-1'), JSON.stringify(forged))
    const call = calls.at(-1)
    check(call && call.deviceName === 'Pixel', 'deviceName comes from the authenticated session via the registry')
    check(call && !('deviceName' in call.action), 'a forged deviceName in the payload never reaches the command')
    await sm.onMessage(session('dev-gone'), JSON.stringify({ ...forged, id: 'k2' }))
    check(calls.length === 2 && calls[1].deviceName === undefined, 'an unknown device yields no name (renderer says "from the phone")')
    check(frames.filter(f => f.type === 'ctlAck').length === 2, 'every ctl is acknowledged')
  }

  // --- PtyManager.killPanes / reconcile (E4-FR-36), fake node-pty -------------
  {
    const procs = []
    const impl = (shell, args, opts) => {
      const exitCbs = []
      const proc = {
        cols: opts.cols, rows: opts.rows, killed: false,
        onData() {}, onExit: cb => exitCbs.push(cb), write() {}, resize() {}, pause() {}, resume() {},
        kill: () => { proc.killed = true; exitCbs.forEach(cb => cb({ exitCode: 1 })) },
        exit: code => exitCbs.forEach(cb => cb({ exitCode: code })),
      }
      procs.push(proc)
      return proc
    }
    const { PtyManager } = load('src/main/pty/PtyManager.ts', {
      require: id => id === 'node-pty' ? { spawn: impl } : id === 'electron' ? { app: { getPath: () => require('node:os').tmpdir() } } : require(id),
      console: { ...console, warn() {} },
      setInterval, clearInterval,
    })
    const sent = []
    const pm = new PtyManager(() => ({ isDestroyed: () => false, send: (ch, p) => sent.push({ ch, p }) }))
    let runningChanges = 0
    pm.setRunningChangeListener(() => { runningChanges++ })
    for (const id of ['a', 'b', 'c', 'd']) pm.spawn({ paneId: id, cols: 80, rows: 24 })
    check(pm.count === 4, 'four ptys spawned')
    check(pm.killPanes(['a', 'missing']) === 1 && pm.count === 3 && procs[0].killed, 'killPanes kills by paneId and counts only live ptys')
    check(pm.reattach('a') === null, 'a killed pane has nothing to reattach (the next mount spawns)')
    check(pm.killPanes(['a']) === 0, 'killPanes is idempotent')
    const exitFrame = sent.find(s => s.ch === 'pty:exit')
    check(exitFrame && exitFrame.p.natural === false, 'a killPanes kill is not a natural exit (no exit card)')
    // d ends on its own: main keeps its output for phones until the pane goes away.
    procs[3].exit(0)
    check(pm.getExited('d') !== null, 'a natural exit keeps the pane output (E6-FR-20)')
    runningChanges = 0
    check(pm.reconcile(['b', 'zzz']) === 1 && pm.count === 1 && procs[2].killed && !procs[1].killed, 'reconcile kills every pty whose pane is not live')
    check(pm.getExited('d') === null && runningChanges >= 2, 'reconcile forgets exit records of panes that no longer exist')
    check(pm.reconcile(['b']) === 0 && pm.count === 1, 'reconcile with every pane live kills nothing')
    procs[1].exit(0)
    check(pm.getExited('b') !== null && pm.killPanes(['b']) === 0 && pm.getExited('b') === null, 'killPanes drops the exit record of a removed pane')
    // A pty superseded by a second spawn for the same pane is killed with it.
    const before = procs.length
    pm.spawn({ paneId: 'o', cols: 80, rows: 24 })
    pm.spawn({ paneId: 'o', cols: 80, rows: 24 })
    check(pm.killPanes(['o']) === 2 && procs[before].killed && procs[before + 1].killed, 'killPanes kills every live pty of the pane, superseded ones too')
    pm.spawn({ paneId: 'o2', cols: 80, rows: 24 })
    pm.spawn({ paneId: 'o2', cols: 80, rows: 24 })
    check(pm.reconcile(['b']) === 2 && pm.count === 0, 'reconcile also catches a superseded pty of a removed pane')
    pm.killAll()

    // The IPC: a malformed reconcile list never reads as "no panes".
    const handlers = {}
    const { registerPtyIpc } = load('src/main/ipc/registerPtyIpc.ts', {
      require: id => id === 'electron' ? { ipcMain: { handle: (ch, fn) => { handlers[ch] = fn }, on: (ch, fn) => { handlers[ch] = fn } } } : require(id),
    })
    const calls = []
    const submits = []
    registerPtyIpc({ killPanes: ids => { calls.push(['kill', ids]); return ids.length }, reconcile: ids => { calls.push(['rec', ids]); return 0 }, submitToPane: (...args) => { submits.push(args); return Promise.resolve({ ok: true }) } })
    // v2.3: pty:submit takes origin 'auto' only; anything else is the user.
    handlers['pty:submit'](null, { ptyId: 'p', text: 'x', enter: false, origin: 'auto' })
    handlers['pty:submit'](null, { ptyId: 'p', text: 'x', enter: false, origin: 'robot' })
    handlers['pty:submit'](null, { ptyId: 'p', text: 'x', enter: true })
    check(submits.map(a => a[4]).join() === 'auto,user,user' && submits[2][3] === true, 'pty:submit validates origin in main (auto or user) and keeps enter')
    check(handlers['pty:killPanes'](null, ['x', 7, 'y']) === 2 && calls[0][1].join() === 'x,y', 'pty:killPanes keeps only string ids')
    check(handlers['pty:reconcile'](null, 'nope') === 0 && calls.length === 1, 'pty:reconcile ignores a non-array payload instead of killing everything')
    handlers['pty:reconcile'](null, ['x'])
    check(calls[1][0] === 'rec' && calls[1][1].join() === 'x', 'pty:reconcile forwards the live list')
  }

  // --- Drag geometry: console grid slots and workspace reorder (pure) ----------
  {
    const { gridSlotAt, dropWorkspace } = loadRenderer(`
      export { gridSlotAt } from '@/components/layout/gridTemplates'
      export { dropWorkspace } from './sidebarOrder'
    `)
    const box = { width: 1006, height: 606 } // 2x2 of 500x300 cells with a 6 px gap
    check(gridSlotAt(250, 150, box, 2, 4, 6) === 0 && gridSlotAt(756, 150, box, 2, 4, 6) === 1 && gridSlotAt(250, 456, box, 2, 4, 6) === 2 && gridSlotAt(756, 456, box, 2, 4, 6) === 3, 'cell centers map to their slots')
    check(gridSlotAt(503, 303, box, 2, 4, 6) === null && gridSlotAt(495, 150, box, 2, 4, 6) === null && gridSlotAt(250, 295, box, 2, 4, 6) === null, 'the junction, the gap and the edges keep the current target (no flicker)')
    check(gridSlotAt(756, 456, box, 2, 3, 6) === null && gridSlotAt(-1, 10, box, 2, 4, 6) === null, 'an empty last slot or a point outside is no target')
    const w = (id, favorite = false) => ({ id, name: id, cwd: '', panes: [], favorite })
    const shown = [w('f1', true), w('f2', true), w('a'), w('b'), w('c')]
    check(dropWorkspace(shown, 'c', 2)?.join() === 'f1,f2,c,a,b', 'a plain workspace moves up to the first plain slot')
    check(dropWorkspace(shown, 'c', 0)?.join() === 'f1,f2,c,a,b', 'it never lands above a favorite')
    check(dropWorkspace(shown, 'f1', 5)?.join() === 'f2,f1,a,b,c', 'a favorite never lands below a plain workspace')
    check(dropWorkspace(shown, 'a', 2) === null && dropWorkspace(shown, 'a', 3) === null, 'dropping in its own gaps changes nothing')
    check(dropWorkspace(shown, 'a', 5)?.join() === 'f1,f2,b,c,a', 'down to the end')
  }

  // --- ptyLifecycle: remove, delete, import, restart (E4-FR-36) ----------------
  {
    const killCalls = []
    const reconcileCalls = []
    let epochAtKill = null
    const r = loadRenderer(`
      export { useAppStore } from './store'
      export { initPtyLifecycle, reconcilePtys, shouldKillLateSpawn, allPaneIds, removedPaneIds } from './ptyLifecycle'
      export { registerPty, getPtyId } from './ptyRegistry'
      export { registerRestarter } from './restartRegistry'
      export { withPanesHome } from './paneHome'
    `, {
      window: { snApi: { config: { save() {} }, pty: {
        killPanes: async ids => { killCalls.push(ids.slice()); return ids.length },
        reconcile: async ids => { reconcileCalls.push(ids.slice()); return 0 },
      } } },
    })
    const S = r.useAppStore
    const pane = id => ({ id, type: 'shell', title: id, icon: 'terminal' })
    S.setState({
      hydrated: true, activeWorkspaceId: 'w1',
      workspaces: [
        { id: 'w1', name: 'Uno', cwd: '', panes: [pane('p1'), pane('p2')], layout: { grid: 2, order: ['p1', 'p2'] } },
        { id: 'w2', name: 'Dos', cwd: '', panes: [pane('q1'), pane('q2')], layout: { grid: 2, order: ['q1', 'q2'] } },
        { id: 'w3', name: 'Tres', cwd: '', panes: [pane('t1')], layout: { grid: 1, order: ['t1'] } },
      ],
      mountedWorkspaces: { w1: 'full' },
    })
    check(r.removedPaneIds(new Set(['a', 'b', 'c']), new Set(['b'])).join() === 'a,c', 'removedPaneIds lists the panes that left')
    const stop = r.initPtyLifecycle()
    check(r.initPtyLifecycle()() === undefined, 'initPtyLifecycle is idempotent')
    await r.reconcilePtys()
    check(reconcileCalls.length === 1 && reconcileCalls[0].sort().join() === 'p1,p2,q1,q2,t1', 'reconcile sends every pane of every workspace (visited or not)')

    S.getState().renamePane('w1', 'p1', 'renamed')
    S.getState().movePane('w1', 'p2', 0)
    check(killCalls.length === 0, 'renames and moves never kill')
    const before = S.getState().workspaces
    S.getState().movePane('w1', 'p2', 0)
    check(S.getState().workspaces === before, 'a drag reporting the slot the console already has changes nothing')

    // Move to workspace (session only): one store change, the pty lives on, config.json keeps it at home.
    const ws = id => S.getState().workspaces.find(w => w.id === id)
    check(S.getState().movePaneToWorkspace('q2', 'w3') === true && killCalls.length === 0, 'moving a console to another workspace never kills it')
    check(ws('w3').panes.map(p => p.id).join() === 't1,q2' && ws('w3').layout.order.join() === 't1,q2' && !ws('w2').panes.some(p => p.id === 'q2'), 'the console shows last in the target workspace')
    check(S.getState().paneHome.q2?.workspaceId === 'w2' && S.getState().paneHome.q2.orderIndex === 1, 'its home and slot are remembered')
    const saved = r.withPanesHome(S.getState().workspaces, S.getState().paneHome)
    check(saved.find(w => w.id === 'w2').layout.order.join() === 'q1,q2' && saved.find(w => w.id === 'w3').panes.length === 1, 'what config.json gets has it back at home, same slot')
    S.getState().movePaneToWorkspace('q2', 'w2')
    check(!S.getState().paneHome.q2 && ws('w2').layout.order.join() === 'q1,q2', 'moving it home forgets the move and restores its slot')
    S.getState().movePaneToWorkspace('q2', 'w3')
    S.getState().closePane('w3', 'q2')
    check(!S.getState().paneHome.q2, 'closing a moved console forgets its home')
    const reopened = S.getState().reopenClosedPane()
    check(reopened?.workspaceId === 'w2' && ws('w2').panes.some(p => p.id === 'q2') && !ws('w3').panes.some(p => p.id === 'q2'), 'reopen brings a moved console back at home, not where it was shown')
    S.getState().movePaneToWorkspace('p1', 'w2')
    killCalls.length = 0

    S.getState().removePane('w1', 'p2')
    check(killCalls.length === 1 && killCalls[0].join() === 'p2', 'removePane kills exactly the removed pane')

    // A workspace never visited after a reload: the renderer registry is empty,
    // the kill still goes by paneId to main.
    check(r.getPtyId('q1') === undefined, 'unvisited workspace has no local pty binding')
    killCalls.length = 0
    S.getState().deleteWorkspace('w2')
    const killed = new Set(killCalls.flat())
    check(killed.has('q1') && killed.has('q2') && killed.size === 2, 'deleteWorkspace kills every pane of an unvisited workspace by paneId')
    check(ws('w1').panes.some(p => p.id === 'p1') && !S.getState().paneHome.p1, 'a console only shown in a deleted workspace goes back home alive')

    killCalls.length = 0
    S.getState().importConfig({ workspaces: [
      { id: 'w1', name: 'Uno', cwd: '', panes: [pane('p1')] },
      { id: 'w9', name: 'Nueva', cwd: '', panes: [pane('n1')] },
    ] })
    check(killCalls.length === 1 && killCalls[0].join() === 't1', 'importConfig kills only the panes that disappear')

    killCalls.length = 0
    S.getState().mergeConfig({ workspaces: [{ id: 'm', name: 'M', cwd: '', panes: [pane('m1')] }] })
    check(killCalls.length === 0, 'mergeConfig adds panes and kills nothing')

    // Restart clean of a console outside the mounted set (phone, a workspace not
    // revisited since a reload): it kills and then mounts, so a shell comes back.
    const merged = S.getState().workspaces.at(-1)
    const mPane = merged.panes[0].id
    check(!(S.getState().mountedWorkspaces[merged.id]), 'the merged workspace is not mounted')
    S.getState().restartPaneClean(mPane)
    const mm = S.getState().mountedWorkspaces[merged.id]
    check(killCalls.length === 1 && killCalls[0].join() === mPane && Array.isArray(mm) && mm.includes(mPane), 'restartPaneClean on an unmounted console kills it and mounts it')

    // Restart clean: the kill goes out before the epoch rises (the remount's
    // reattach then finds nothing and spawns).
    killCalls.length = 0
    const epochBefore = S.getState().paneEpoch.p1 ?? 0
    const unsubOrder = S.subscribe(s => { if ((s.paneEpoch.p1 ?? 0) !== epochBefore) epochAtKill = killCalls.length })
    S.getState().restartPaneClean('p1')
    unsubOrder()
    check(killCalls.length === 1 && killCalls[0].join() === 'p1' && epochAtKill === 1, 'restartPaneClean kills before bumping paneEpoch')
    check(S.getState().paneEpoch.p1 === epochBefore + 1, 'restartPaneClean remounts the console')

    // restartPane with a mounted terminal goes in place (R21-08): no kill, no remount.
    killCalls.length = 0
    let inPlace = 0
    r.registerRestarter('n1', () => { inPlace++ })
    S.getState().restartPane('n1')
    check(inPlace === 1 && killCalls.length === 0 && !S.getState().paneEpoch.n1, 'restartPane on a mounted console restarts in place without killing')
    // ...and an unmounted one falls back to the clean path, which kills first.
    S.getState().restartPane('p1')
    check(killCalls.length === 1 && killCalls[0].join() === 'p1', 'restartPane on an unmounted console kills before the remount')

    // A spawn resolving after its terminal unmounted.
    r.registerPty('p1', 'pty-new')
    check(r.shouldKillLateSpawn('p1', 'pty-new') === false, 'a late spawn that is the pane binding survives')
    check(r.shouldKillLateSpawn('p1', 'pty-old') === true, 'a late spawn superseded by another pty is killed')
    check(r.shouldKillLateSpawn('n1', 'pty-x') === false, 'a late spawn of a live, unbound pane survives for the next mount')
    check(r.shouldKillLateSpawn('gone', 'pty-y') === true, 'a late spawn of a removed pane is killed')

    stop()
    killCalls.length = 0
    S.getState().removePane('w1', 'p1')
    check(killCalls.length === 0, 'a stopped lifecycle no longer kills')
  }

  // --- useXterm: the unmount never kills (E4-FR-36) -----------------------------
  {
    const fs = require('node:fs')
    const src = fs.readFileSync(path.join(root, 'src/renderer/components/terminal/useXterm.ts'), 'utf8')
    const cleanup = src.slice(src.indexOf('    return () => {\n      disposed = true'), src.indexOf('startedRef.current = false'))
    check(cleanup.length > 0 && !/pty\.kill\(/.test(cleanup), 'the useXterm cleanup has no pty.kill')
    check((src.match(/shouldKillLateSpawn\(/g) || []).length === 2, 'both late-resolving launches (spawn, restart) use shouldKillLateSpawn')
  }

  // --- update state in main + the UPDATE_INSTALL guard (E4-FR-37) --------------
  {
    const handlers = {}
    const timers = []
    const fakeElectron = { ipcMain: { handle: (ch, fn) => { handlers[ch] = fn }, on() {} }, app: { getVersion: () => '2.0.0', isPackaged: false }, net: {}, shell: {} }
    const mod = load('src/main/ipc/registerUpdateIpc.ts', {
      require: id => id === 'electron' ? fakeElectron : require(id),
      setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    })
    const stateMod = load('src/main/updateState.ts')
    const state = new stateMod.UpdateStateStore()
    const sent = []
    const installing = []
    let quits = 0
    let installCalls = 0
    let pending = null
    mod.registerUpdateIpc({
      getSender: () => ({ isDestroyed: () => false, send: (ch, p) => sent.push({ ch, p }) }),
      quitForUpdate: () => { quits++ },
      setInstalling: v => installing.push(v),
      check: async () => ({ available: true }),
      install: onProgress => { installCalls++; pending = { onProgress }; return new Promise((resolve, reject) => { pending.resolve = resolve; pending.reject = reject }) },
      state,
    })
    const info = { available: true, currentVersion: '2.0.0', latestVersion: '2.1.0', notes: '', releaseUrl: null, installable: true, installKind: 'win-portable' }
    state.checked(info)
    check(handlers['update:getState']().phase === 'available' && handlers['update:getState']().info.latestVersion === '2.1.0', 'a good check moves main to available with its info')
    const p1 = handlers['update:install']()
    const p2 = handlers['update:install']()
    check(p1 === p2 && installCalls === 1, 'a second update:install joins the running one (same promise, one download)')
    check(state.get().phase === 'downloading' && installing.at(-1) === true, 'install starts downloading and blocks close')
    const stateFrames = () => sent.filter(s => s.ch === 'update:state').map(s => s.p.phase)
    check(stateFrames().join() === 'available,downloading', 'update:state is pushed on every phase change')
    pending.onProgress({ percent: 42, transferred: 42, total: 100 })
    check(state.get().progress.percent === 42 && sent.at(-1).ch === 'update:progress', 'progress is stored in main and streamed')
    check(stateFrames().length === 2, 'progress alone does not push a state frame')
    // A reload mid-download: getState hands the phase and the live percent back.
    const reloaded = handlers['update:getState']()
    check(reloaded.phase === 'downloading' && reloaded.progress.percent === 42 && reloaded.info.latestVersion === '2.1.0', 'getState after a reload returns downloading at 42%')
    state.checked({ ...info, latestVersion: '2.2.0' })
    check(state.get().info.latestVersion === '2.1.0' && state.get().phase === 'downloading', 'a check during the download changes nothing')
    pending.onProgress({ percent: 100, transferred: 100, total: 100 })
    check(state.get().phase === 'installing' && installing.at(-1) === true, '100% with the apply pending is installing (close still blocked)')
    pending.resolve({ relaunching: false })
    const res = await p1
    check(res.relaunching === false && state.get().phase === 'opened' && installing.at(-1) === false, 'an opened installer ends in opened and unblocks close')
    check(timers.length === 0 && quits === 0, 'no relaunch when the installer only opened')

    // After it settles a new install really starts again.
    const p3 = handlers['update:install']()
    check(p3 !== p1 && installCalls === 2, 'a finished install releases the guard')
    pending.reject(new Error('missing-checksum'))
    let failed = null
    try { await p3 } catch (err) { failed = err }
    check(failed && state.get().phase === 'failed' && state.get().installError === 'missing-checksum' && installing.at(-1) === false, 'a failed install ends in failed with its error')

    const p4 = handlers['update:install']()
    check(state.get().installError === null, 'a retry clears the previous error')
    pending.resolve({ relaunching: true })
    await p4
    check(state.get().phase === 'installing' && timers.length === 1 && timers[0].ms === 400, 'a relaunching install keeps installing and schedules the quit')
    timers[0].fn()
    check(quits === 1, 'quitForUpdate runs')

    // A failed check keeps the phase; a good one after an outcome resets it.
    const s2 = new stateMod.UpdateStateStore()
    s2.checked(info); s2.begin(); s2.failed('boom')
    s2.checked({ ...info, available: false, error: 'offline' })
    check(s2.get().phase === 'failed' && s2.get().installError === 'boom', 'a failed check keeps the install outcome')
    const s3 = new stateMod.UpdateStateStore()
    const s3frames = []
    s3.onChange(s => s3frames.push(s.phase))
    s3.checked({ ...info, available: false, error: 'offline' })
    check(s3.get().phase === 'idle' && s3.get().info.error === 'offline', 'a first failed check records its error info')
    s3.checked(info)
    s3.checked({ ...info, available: false, latestVersion: null, error: 'offline' })
    check(s3.get().phase === 'available' && s3.get().info.available && s3.get().info.latestVersion === '2.1.0' && s3frames.length === 2, 'a failed recheck keeps available with its good info (no contradictory state)')
    s2.checked({ ...info, available: false })
    check(s2.get().phase === 'idle' && s2.get().installError === null, 'a good check with nothing newer goes idle')
    check(stateMod.isUpdateBusy('downloading') && stateMod.isUpdateBusy('installing') && !stateMod.isUpdateBusy('opened'), 'busy phases are downloading and installing')
  }

  // --- renderer mirror of main's update state (E4-FR-37) -----------------------
  {
    let stateCb = null
    let progressCb = null
    const r = loadRenderer(`export { useUpdaterStore, initUpdaterEvents, mirrorUpdateState, isInstallPhase } from './updater'`, {
      window: { snApi: { updates: {
        getState: async () => ({ phase: 'downloading', progress: { percent: 40, transferred: 4, total: 10 }, installError: null, info: { available: true, latestVersion: '2.1.0' } }),
        onState: cb => { stateCb = cb; return () => { stateCb = null } },
        onProgress: cb => { progressCb = cb; return () => { progressCb = null } },
        check: async () => ({ available: true, latestVersion: '9.9.9' }),
      } } },
    })
    const U = r.useUpdaterStore
    const off = r.initUpdaterEvents()
    await new Promise(res => setTimeout(res, 0))
    let st = U.getState()
    check(st.phase === 'downloading' && st.installing && st.progress.percent === 40 && st.info.latestVersion === '2.1.0', 'a reload rehydrates downloading at 40% from main')
    progressCb({ percent: 55, transferred: 5, total: 10 })
    check(U.getState().progress.percent === 55, 'the live percent keeps streaming')
    await U.getState().check()
    check(U.getState().info.latestVersion === '2.1.0', 'a check during the download keeps the info being installed')
    stateCb({ phase: 'failed', progress: null, installError: "Error invoking remote method 'update:install': Error: missing-checksum", info: null })
    st = U.getState()
    check(st.phase === 'failed' && !st.installing && st.installError === 'missing-checksum' && st.info.latestVersion === '2.1.0', 'a failed phase from main maps the checksum code and keeps the info')
    stateCb({ phase: 'opened', progress: null, installError: null, info: null })
    check(U.getState().opened && !U.getState().installing, 'opened mirrors from main')
    check(r.isInstallPhase('installing') && !r.isInstallPhase('available'), 'the close button is blocked only while downloading/installing')
    off()
    check(stateCb === null && progressCb === null, 'initUpdaterEvents unsubscribes')
  }


  // --- Settings search, deep links, key chips and wizard keys (E4-FR-26..31) ---
  {
    const fs = require('node:fs')
    const c = loadRenderer(`
      export * from '../components/settings/searchCatalog'
      export { accelParts, ariaKeyshortcuts, KEY_ACTIONS } from './keymap'
      export { wizardKeyAction, enterIsNative, initialWizardFocus, trapTabIndex } from '../components/wizard/wizardKeys'
      export { en } from '../i18n/en'
      export { es } from '../i18n/es'
      export { useAppStore } from './store'
    `, { window: { snApi: { config: { save() {} } } } })
    const m = c.matchesSettingsSearch
    check(m('sonido', ['Sonido de notificación']) && m('NOTIFICACION', ['Sonido de notificación']), 'case and accents ignored on both sides')
    check(m('notificación', ['Sonido de notificacion']) && m('accion', ['Requiere acción']), 'an accented query matches plain text and vice versa')
    check(m('sonido notif', ['Sonido', 'Notificaciones']) && !m('sonido discord', ['Sonido', 'Notificaciones']), 'tokens are ANDed across the haystack')
    check(m('', ['x']) && m('   ', ['x']), 'an empty or blank query matches everything')
    check(!m('xyzzy', ['Sonido', 'Notificaciones']), 'no token, no match')
    check(c.normalizeSearch('Ñandú ÁÉÍ') === 'nandu aei', 'normalizeSearch strips diacritics (NFD) and lowercases')
    check(JSON.stringify(c.highlightRanges('Notificación de sonido', 'notificacion sonido')) === '[[0,12],[16,22]]', 'highlight ranges map folded hits back to the original offsets')
    check(JSON.stringify(c.highlightRanges('aaa', 'a aa')) === '[[0,3]]' && c.highlightRanges('abc', '').length === 0, 'overlapping hits merge, empty query has none')

    // Deep link targets.
    const p = c.parseSettingsTarget
    check(JSON.stringify(p('notifications#sound')) === '{"category":"notifications","anchor":"notifications.sound"}', "'notifications#sound' -> category + full row id")
    check(JSON.stringify(p('remote')) === '{"category":"remote","anchor":null}' && p(null).category === null, "'remote' stays a bare category (compatible)")
    check(p('bogus#x').category === null && p('bogus#x').anchor === null, 'an unknown category is ignored')
    check(c.settingDomId('notifications.inAppWhenFocused') === 'setting-notifications-inAppWhenFocused', "DOM id = 'setting-' + id with dots as dashes")

    // Inline toggles patch one nested path without touching siblings.
    const settings = { notifications: { sound: false, volume: 40, discord: { enabled: false, webhookUrl: 'w' } }, autoCheckUpdates: true }
    const patch = c.settingsPatchForPath(settings, 'notifications.discord.enabled', true)
    check(patch.notifications.discord.enabled === true && patch.notifications.discord.webhookUrl === 'w' && patch.notifications.volume === 40, 'nested patch keeps the siblings')
    check(settings.notifications.discord.enabled === false, 'the patch never mutates the current settings')
    check(c.settingsPatchForPath(settings, 'autoCheckUpdates', false).autoCheckUpdates === false && c.readSettingPath(settings, 'notifications.discord.webhookUrl') === 'w' && c.readSettingPath(settings, 'nope.deep') === undefined, 'top-level patch and readSettingPath')

    // Catalog integrity: every searchId in the sections exists in the catalog and vice versa.
    const sectionsDir = path.join(root, 'src/renderer/components/settings/sections')
    const sectionIds = []
    for (const file of fs.readdirSync(sectionsDir).filter(f => f.endsWith('.tsx'))) {
      const src = fs.readFileSync(path.join(sectionsDir, file), 'utf8')
      const ids = [...src.matchAll(/searchId="([^"]+)"/g)].map(x => x[1])
      const rows = (src.match(/<(SettingRow|ToggleRow)\b/g) || []).length
      check(rows === ids.length, `${file}: every SettingRow/ToggleRow has a searchId (${ids.length}/${rows})`)
      sectionIds.push(...ids)
    }
    const catalog = c.SETTINGS_CATALOG
    const rowIds = catalog.filter(e => !e.summary).map(e => e.id)
    check(new Set(sectionIds).size === sectionIds.length, 'searchIds are unique across sections')
    check(sectionIds.every(id => rowIds.includes(id)), 'every section searchId is in searchCatalog.ts: ' + sectionIds.filter(id => !rowIds.includes(id)).join())
    check(rowIds.every(id => sectionIds.includes(id)), 'every catalog row exists as a searchId in a section: ' + rowIds.filter(id => !sectionIds.includes(id)).join())
    const all = c.ALL_SEARCH_ENTRIES
    check(new Set(all.map(e => e.id)).size === all.length, 'catalog ids are unique')
    check(all.every(e => e.id.startsWith(e.category + '.') && c.CATEGORY_ORDER.includes(e.category)), "ids are '<category>.<key>' of a known category")
    check(c.KEY_ACTIONS.every(a => all.some(e => e.id === 'keys.' + a.id && e.titleKey === a.labelKey)), 'every KEY_ACTIONS action is a searchable Keys row')
    for (const cat of ['agents', 'connections', 'quick', 'data', 'usage', 'about', 'updates', 'remote']) check(catalog.some(e => e.category === cat && e.summary), `custom block ${cat} has a summary row`)
    const keysUsed = all.flatMap(e => [e.titleKey, e.descriptionKey, e.groupKey].filter(Boolean)).concat(Object.values(c.CATEGORY_LABEL))
    check(keysUsed.every(k => k in c.en && k in c.es), 'every catalog message key exists in en and es: ' + keysUsed.filter(k => !(k in c.en && k in c.es)).join())
    check(catalog.filter(e => e.toggle).every(e => typeof c.readSettingPath(c.useAppStore.getState().settings, e.toggle.path) === 'boolean'), 'inline toggles point at boolean settings')

    // Searching with the real Spanish strings.
    const tEs = k => c.es[k]
    const ids = q => c.searchSettings(q, tEs).flatMap(g => g.entries.map(e => e.id))
    const sonido = c.searchSettings('sonido', tEs)
    check(sonido.length === 1 && sonido[0].category === 'notifications' && sonido[0].entries.some(e => e.id === 'notifications.sound'), '"sonido" finds the row under Notificaciones only')
    check(ids('paleta').includes('keys.palette'), '"paleta" finds the Keys row')
    check(c.searchSettings('xyzzy', tEs).length === 0, '"xyzzy" finds nothing (empty state)')
    check(ids('notificaciones').length >= 10 && ids('notificaciones').every(id => id.startsWith('notifications.')), 'the category label matches every row in it')
    check(ids('despierta').includes('agents.awake') && ids('pantalla').includes('agents.awakeDisplay'), 'Behavior rows match by title')
    check(ids('discord paleta').length === 0 && ids('discord sonido').join() === 'notifications.inAppWhenFocused' && ids('discord').includes('notifications.discordDone'), 'multi-token AND across rows')
    check(c.searchSettings('ctrl k', tEs, e => (e.id === 'keys.palette' ? ['Ctrl+K'] : [])).some(g => g.entries.some(e => e.id === 'keys.palette')), 'a key row matches its live accelerator')
    const order = c.searchSettings('a', tEs).map(g => g.category)
    check(order.join() === c.CATEGORY_ORDER.filter(x => order.includes(x)).join(), 'groups come in nav order')

    // Store: query, anchor, prefill.
    const S = c.useAppStore
    S.getState().setSettingsQuery('algo')
    S.getState().openSettings('notifications#sound')
    let st = S.getState()
    check(st.settingsOpen && st.settingsCategory === 'notifications#sound' && st.settingsAnchor === 'notifications.sound' && st.settingsQuery === '', 'openSettings(cat#row) opens, sets the anchor and clears the query')
    S.getState().openSettings('remote')
    check(S.getState().settingsAnchor === null && S.getState().settingsCategory === 'remote', 'openSettings(cat) has no anchor')
    S.getState().setSettingsQuery('x'); S.getState().setSettingsAnchor('a.b'); S.getState().setSettingsOpen(false)
    st = S.getState()
    check(!st.settingsOpen && st.settingsQuery === '' && st.settingsAnchor === null, 'closing settings clears query and anchor')
    S.getState().setWizardOpen(true, { cwd: 'C:\\repo' })
    check(S.getState().wizardOpen && S.getState().wizardPrefill.cwd === 'C:\\repo', 'setWizardOpen(true, prefill) stores the prefill')
    S.getState().setWizardOpen(false)
    check(S.getState().wizardPrefill === null, 'closing the wizard drops the prefill')
    S.getState().setWizardOpen(true)
    check(S.getState().wizardPrefill === null, 'opening without prefill starts empty')
    S.getState().setWizardOpen(false)

    // Key chips.
    check(JSON.stringify(c.accelParts('Ctrl+Shift+N')) === '["Ctrl","Shift","N"]' && JSON.stringify(c.accelParts('Meta+K')) === '["Win","K"]', 'accelParts splits and shows Meta as Win')
    check(JSON.stringify(c.accelParts('Ctrl++')) === '["Ctrl","+"]' && JSON.stringify(c.accelParts('+')) === '["+"]' && c.accelParts('').length === 0, 'accelParts handles the plus key and empty')
    check(c.ariaKeyshortcuts(['Ctrl', 'Enter']) === 'Control+Enter' && c.ariaKeyshortcuts(['Ctrl', 'Alt', 'Left']) === 'Control+Alt+ArrowLeft' && c.ariaKeyshortcuts(['Win', '+']) === 'Meta+Plus', 'aria-keyshortcuts uses the ARIA key names')

    // Wizard keyboard model.
    const k = (key, mods = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, ...mods })
    const el = (tagName, extra = {}) => ({ tagName, isContentEditable: false, getAttribute: n => (extra.attrs || {})[n] ?? null, ...extra })
    const w = c.wizardKeyAction
    const ready = { canAdvance: true, hasCwd: true }
    check(w(k('Enter'), el('INPUT'), ready) === 'advance', 'Enter in the folder input advances')
    check(w(k('Enter'), el('INPUT'), { canAdvance: false, hasCwd: false }) === 'block', 'Enter without a folder is swallowed and does not advance')
    check(w(k('Enter'), el('SELECT'), ready) === null && w(k('Enter'), el('TEXTAREA'), ready) === null, 'Enter in a select or textarea keeps its native meaning')
    check(w(k('Enter'), el('BUTTON'), ready) === null && w(k('Enter'), el('A'), ready) === null, 'buttons and links keep their native activation')
    check(['combobox', 'listbox', 'menu'].every(role => w(k('Enter'), el('DIV', { attrs: { role } }), ready) === null), 'role combobox/listbox/menu is left alone')
    check(w(k('Enter'), el('DIV', { isContentEditable: true }), ready) === null, 'contentEditable is left alone')
    check(w(k('Enter', { isComposing: true }), el('INPUT'), ready) === null && w(k('Enter', { ctrlKey: true, isComposing: true }), el('INPUT'), ready) === null, 'an IME composition is never intercepted')
    check(w(k('Enter', { ctrlKey: true }), el('SELECT'), ready) === 'create' && w(k('Enter', { metaKey: true }), el('BUTTON'), ready) === 'create', 'Ctrl+Enter creates from anywhere')
    check(w(k('Enter', { ctrlKey: true }), el('INPUT'), { canAdvance: false, hasCwd: false }) === 'block', 'Ctrl+Enter without a folder does nothing')
    check(w(k('a'), el('INPUT'), ready) === null && w(k('Enter', { altKey: true }), el('INPUT'), ready) === null && w(k('Enter', { shiftKey: true }), el('INPUT'), ready) === null, 'other keys and Alt/Shift+Enter are not ours')
    check(!c.enterIsNative(null) && !c.enterIsNative(el('INPUT')), 'enterIsNative: plain input and null')
    check(c.initialWizardFocus('') === 'cwd' && c.initialWizardFocus('  ') === 'cwd' && c.initialWizardFocus('C:\\repo') === 'primary', 'initial focus: folder input, or the primary when prefilled')
    check(c.trapTabIndex(3, 2, false) === 0 && c.trapTabIndex(3, 0, true) === 2 && c.trapTabIndex(3, -1, false) === 0 && c.trapTabIndex(3, -1, true) === 2 && c.trapTabIndex(0, 0, false) === -1, 'Tab wraps inside the dialog both ways')
  }

  // --- "Open in SnAgentsOS": --open parsing and validation (E4-FR-32) ----------
  {
    const o = load('src/main/openRequest.ts')
    const p = (argv, cwd = '') => o.parseOpenArg(['C:\\App\\SnAgentsOS.exe', ...argv], cwd)
    check(p(['--open', 'C:\\repo']) === 'C:\\repo' && p(['--open=C:\\repo']) === 'C:\\repo', '--open X and --open=X')
    check(p(['--open', 'C:\\repo\\']) === 'C:\\repo' && p(['--open=D:/work/app/']) === 'D:\\work\\app', 'trailing separator dropped, slashes unified')
    check(p(['--open', 'C:"']) === 'C:\\' && p(['--open=C:"']) === 'C:\\' && p(['--open', 'D:\\sub\\"']) === 'D:\\sub', 'drive root quoting: C:" is C:\\')
    check(p(['--open', '"C:\\Program Files\\repo"']) === 'C:\\Program Files\\repo', 'surrounding quotes are removed')
    check(p(['--open', 'repo'], 'C:\\work') === 'C:\\work\\repo' && p(['--open', '..\\other'], 'C:\\work\\a') === 'C:\\work\\other' && p(['--open=.'], 'C:\\work') === 'C:\\work', 'relative paths resolve against the event cwd')
    check(p(['--open', '--allow-file-access-from-files', '--original-process-start-time=1337', 'C:\\repo']) === 'C:\\repo', 'Chromium switches between --open and its value are skipped')
    check(p(['--allow-file-access-from-files', '--open=C:\\repo', '--enable-features=X']) === 'C:\\repo', 'switches before and after --open=')
    check(p(['--open']) === null && p(['--open', '--x']) === null && p(['--open=']) === null && p([]) === null && p(['C:\\repo']) === null, 'no value, or no --open, is null')
    check(p(['--open', '\\\\wsl$\\Ubuntu\\home\\me']) === '\\\\wsl$\\Ubuntu\\home\\me' && p(['--open', '\\\\wsl.localhost\\Ubuntu\\']) === '\\\\wsl.localhost\\Ubuntu' && p(['--open=\\\\server\\share\\dir']) === '\\\\server\\share\\dir', 'UNC and \\\\wsl$ survive')
    check(o.isAcceptableOpenPath('C:\\repo') && o.isAcceptableOpenPath('\\\\wsl$\\Ubuntu') && o.isAcceptableOpenPath('\\\\server\\share\\x') && o.isAcceptableOpenPath('/home/me'), 'absolute drive, UNC and posix paths are acceptable')
    check(!o.isAcceptableOpenPath('repo') && !o.isAcceptableOpenPath('\\repo') && !o.isAcceptableOpenPath('\\\\server') && !o.isAcceptableOpenPath('\\\\.\\PhysicalDrive0') && !o.isAcceptableOpenPath('\\\\?\\C:\\x') && !o.isAcceptableOpenPath('C:\\' + 'a'.repeat(1030)) && !o.isAcceptableOpenPath(''), 'relative, rootless, device and over-long paths are refused')

    const warns = []
    const warn = msg => warns.push(msg)
    const fakeStat = map => async q => {
      if (!(q in map)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return { isDirectory: () => map[q] === 'dir', isFile: () => map[q] === 'file' }
    }
    const stat = fakeStat({ 'C:\\repo': 'dir', 'C:\\repo\\a.txt': 'file', '\\\\wsl$\\Ubuntu\\home': 'dir', 'C:\\dev': 'other' })
    check(await o.validateOpenPath('C:\\repo', stat, 3000, warn) === 'C:\\repo', 'an existing folder is valid')
    check(await o.validateOpenPath('C:\\repo\\a.txt', stat, 3000, warn) === 'C:\\repo', 'a file opens its folder')
    check(await o.validateOpenPath('\\\\wsl$\\Ubuntu\\home', stat, 3000, warn) === '\\\\wsl$\\Ubuntu\\home', '\\\\wsl$ folder is valid')
    check(await o.validateOpenPath('C:\\missing', stat, 3000, warn) === null && /does not exist/.test(warns.at(-1)), 'a missing path is null with a warning')
    check(await o.validateOpenPath('C:\\dev', stat, 3000, warn) === null && /not a folder/.test(warns.at(-1)), 'neither file nor folder is null')
    check(await o.validateOpenPath('relative', stat, 3000, warn) === null && await o.validateOpenPath(null, stat, 3000, warn) === null, 'unacceptable paths never reach the stat')
    const t0 = Date.now()
    const hung = await o.validateOpenPath('\\\\deadserver\\share', () => new Promise(() => {}), 60, warn)
    const took = Date.now() - t0
    check(hung === null && /within 60 ms/.test(warns.at(-1)) && took < 1000, `a stat that never answers times out (${took} ms)`)

    const pushed = []
    const q = new o.OpenRequestQueue(req => pushed.push(req))
    check(q.take() === null, 'empty queue')
    const r1 = o.makeOpenRequest('C:\\repo', 'argv'), r2 = o.makeOpenRequest('C:\\other', 'second-instance')
    check(typeof r1.id === 'string' && r1.id.length >= 16 && r1.id !== r2.id && r2.source === 'second-instance', 'requests get unique ids')
    q.offer(r1); q.offer(r2)
    check(pushed.length === 2 && q.take() === r2 && q.take() === null, 'every offer pushes; take consumes the latest once')

    const n = o.normalizeOpenPath
    check(n('C:\\Repos\\App\\') === 'c:\\repos\\app' && n('c:/repos/app') === 'c:\\repos\\app' && n('C:\\Repos\\.\\x\\..\\App') === 'c:\\repos\\app', 'normalize: case, trailing separator, slashes, dot segments')
    check(n('C:\\') === 'c:' && n('C:') === 'c:' && n('C:\\..\\..') === 'c:', 'drive root, never above it')
    check(n('\\\\Server\\Share\\Dir\\') === '\\\\server\\share\\dir' && n('//wsl$/Ubuntu/home') === '\\\\wsl$\\ubuntu\\home' && n('\\\\srv\\share\\..\\..') === '\\\\srv\\share', 'UNC keeps its prefix and root')
    check(n('') === '' && n('  ') === '', 'empty')
  }

  // --- "Open in SnAgentsOS": matching and dispatch in the renderer (E4-FR-33) ---
  {
    const raf = []
    const storage = new Map()
    const sessionStorage = { getItem: k => storage.has(k) ? storage.get(k) : null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) }
    let pending = null, openCb = null, takes = 0
    const snApi = {
      config: { save() {} }, pty: { write() {} },
      app: { takePendingOpen: async () => { takes++; const r = pending; pending = null; return r }, onOpenPath: cb => { openCb = cb; return () => { openCb = null } } },
    }
    const overrides = {
      window: { snApi }, sessionStorage, document: { hasFocus: () => true },
      requestAnimationFrame: fn => { raf.push(fn); return raf.length }, cancelAnimationFrame() {},
    }
    const src = `
      export { useAppStore } from './store'
      export { useToastStore } from './toast'
      export { pickOpenWorkspace, dispatchOpenRequest, initOpenRequests, setWizardDraftCwd } from './openRequest'
    `
    const r = loadRenderer(src, overrides)
    const S = r.useAppStore
    const ws = (id, cwd, extra = {}) => ({ id, name: id, cwd, panes: [{ id: id + '-p', type: 'shell', title: 'c', icon: 'terminal' }], ...extra })
    const workspaces = [
      ws('wa', 'C:\\Repos\\App', { setupId: 'conn1' }),
      ws('wb', 'c:/repos/app/'),
      ws('wc', 'C:\\Other'),
      ws('wd', 'C:\\Other\\', { favorite: true }),
      ws('we', '\\\\srv\\share\\proj', { setupId: 'conn1' }),
      ws('wf', '\\\\SRV\\Share\\Proj\\', { setupId: 'conn2' }),
    ]
    const pick = (path, active = null) => r.pickOpenWorkspace(workspaces, active, path)?.id ?? null
    check(pick('C:\\REPOS\\APP') === 'wb' && pick('c:\\repos\\app\\', 'wa') === 'wb', 'same folder in any case or trailing slash; no setupId wins even over the active one')
    check(pick('C:\\Other', 'wc') === 'wc' && pick('C:\\Other', 'wd') === 'wd', 'tie: the active workspace first')
    check(pick('c:/other') === 'wd', 'tie without the active: sidebar order (favorites first)')
    check(pick('\\\\srv\\share\\proj', 'wf') === 'wf' && pick('\\\\srv\\share\\proj') === 'we', 'only setupId workspaces still match, active then order')
    check(pick('C:\\Nope') === null && pick('') === null, 'no match')

    S.setState({ hydrated: true, workspaces, activeWorkspaceId: 'wc', mountedWorkspaces: { wc: 'full' }, settingsOpen: true, paletteOpen: true })
    S.getState().updateSettings({ language: 'es' })
    check(r.dispatchOpenRequest({ id: 'r1', path: 'C:\\repos\\app', source: 'argv' }) === 'activated', 'an existing folder activates its workspace')
    let st = S.getState()
    check(st.activeWorkspaceId === 'wb' && st.mountedWorkspaces.wb && !st.settingsOpen && !st.paletteOpen && !st.wizardOpen, 'workspace mounted and active, palette and Settings closed')
    check(r.dispatchOpenRequest({ id: 'r1', path: 'C:\\repos\\app', source: 'argv' }) === 'duplicate', 'the same id never runs twice')
    check(r.dispatchOpenRequest({ path: 'C:\\x' }) === 'ignored' && r.dispatchOpenRequest(null) === 'ignored' && r.dispatchOpenRequest({ id: 'z', path: '' }) === 'ignored', 'malformed requests are ignored')

    S.setState({ settingsOpen: true, paletteOpen: true })
    check(r.dispatchOpenRequest({ id: 'r2', path: 'D:\\New\\proj', source: 'second-instance' }) === 'wizard', 'a new folder opens the wizard')
    st = S.getState()
    check(st.wizardOpen && st.wizardPrefill.cwd === 'D:\\New\\proj' && st.wizardPrefill.name === 'proj' && !st.settingsOpen && !st.paletteOpen, 'wizard prefilled with cwd and basename, above a closed Settings and palette')

    r.setWizardDraftCwd('D:\\New\\proj')
    check(r.dispatchOpenRequest({ id: 'r3', path: 'd:/new/proj/', source: 'second-instance' }) === 'wizard' && S.getState().wizardPrefill.cwd === 'D:\\New\\proj', 'the same folder again leaves the wizard alone')
    check(r.dispatchOpenRequest({ id: 'r4', path: 'E:\\Work\\api', source: 'second-instance' }) === 'busy', 'another folder does not overwrite the wizard')
    const busy = r.useToastStore.getState().items.find(t => t.dedupeKey === 'open:wizardBusy')
    check(busy && busy.kind === 'info' && busy.title === 'Terminá o cancelá el workspace en creación para abrir api' && S.getState().wizardPrefill.cwd === 'D:\\New\\proj', 'info toast names the folder; the draft survives')
    r.setWizardDraftCwd('')
    check(r.dispatchOpenRequest({ id: 'r5', path: 'F:\\y', source: 'second-instance' }) === 'wizard' && S.getState().wizardPrefill.cwd === 'F:\\y', 'an open wizard with no folder yet takes the new one')
    r.setWizardDraftCwd(null)

    S.setState({ hydrated: false, wizardOpen: false, wizardPrefill: null })
    check(r.dispatchOpenRequest({ id: 'r6', path: 'C:\\Other', source: 'argv' }) === 'ignored', 'before hydrate nothing runs')
    S.setState({ hydrated: true })
    check(r.dispatchOpenRequest({ id: 'r6', path: 'C:\\Other', source: 'argv' }) === 'activated' && S.getState().activeWorkspaceId === 'wd', 'the same request runs once hydrated')
    S.setState({ wizardOpen: true, wizardPrefill: null, activeWorkspaceId: 'wd' })
    r.setWizardDraftCwd('')
    check(r.dispatchOpenRequest({ id: 'r7', path: 'C:\\Repos\\App', source: 'argv' }) === 'activated' && !S.getState().wizardOpen && S.getState().activeWorkspaceId === 'wb', 'an empty wizard closes so the activated workspace shows')
    S.setState({ wizardOpen: true })
    r.setWizardDraftCwd('G:\\draft')
    check(r.dispatchOpenRequest({ id: 'r8', path: 'C:\\Other', source: 'argv' }) === 'activated' && S.getState().wizardOpen, 'a wizard with a folder typed is never closed by an activation')
    r.setWizardDraftCwd(null)
    S.setState({ wizardOpen: false })

    // A reload: fresh module state, same sessionStorage.
    const r2 = loadRenderer(src, overrides)
    r2.useAppStore.setState({ hydrated: true, workspaces, activeWorkspaceId: 'wa' })
    check(r2.dispatchOpenRequest({ id: 'r1', path: 'C:\\repos\\app', source: 'argv' }) === 'duplicate' && r2.useAppStore.getState().activeWorkspaceId === 'wa', 'a request handled before a reload is not handled again')

    // initOpenRequests: pulls what main holds, then follows pushes.
    pending = { id: 'p1', path: 'C:\\Repos\\App', source: 'argv' }
    r2.useAppStore.setState({ activeWorkspaceId: 'wc' })
    const stop = r2.initOpenRequests()
    await new Promise(res => setTimeout(res, 10))
    check(takes === 1 && r2.useAppStore.getState().activeWorkspaceId === 'wb' && typeof openCb === 'function', 'init takes the pending request and subscribes')
    pending = { id: 'p2', path: 'C:\\Other', source: 'second-instance' }
    openCb(pending)
    await new Promise(res => setTimeout(res, 10))
    check(takes === 2 && pending === null && r2.useAppStore.getState().activeWorkspaceId === 'wd', 'a push is handled and then cleared from main (dedupe skips the echo)')
    stop()
    check(openCb === null, 'stop unsubscribes')
  }

  // --- Explorer context menu keys (E4-FR-34) -----------------------------------
  {
    const si = load('src/main/shellIntegration.ts')
    const exe = 'C:\\Program Files\\SnAgentsOS\\SnAgentsOS.exe'
    const F = 'HKCU\\Software\\Classes\\Directory\\shell\\SnAgentsOS', B = 'HKCU\\Software\\Classes\\Directory\\Background\\shell\\SnAgentsOS'
    assert.deepStrictEqual(JSON.parse(JSON.stringify(si.buildExplorerRegOps(exe, 'Abrir en SnAgentsOS'))), [
      ['add', F, '/ve', '/t', 'REG_SZ', '/d', 'Abrir en SnAgentsOS', '/f'],
      ['add', F, '/v', 'Icon', '/t', 'REG_SZ', '/d', '"C:\\Program Files\\SnAgentsOS\\SnAgentsOS.exe",0', '/f'],
      ['add', F + '\\command', '/ve', '/t', 'REG_SZ', '/d', '"C:\\Program Files\\SnAgentsOS\\SnAgentsOS.exe" --open "%V"', '/f'],
      ['add', B, '/ve', '/t', 'REG_SZ', '/d', 'Abrir en SnAgentsOS', '/f'],
      ['add', B, '/v', 'Icon', '/t', 'REG_SZ', '/d', '"C:\\Program Files\\SnAgentsOS\\SnAgentsOS.exe",0', '/f'],
      ['add', B + '\\command', '/ve', '/t', 'REG_SZ', '/d', '"C:\\Program Files\\SnAgentsOS\\SnAgentsOS.exe" --open "%V"', '/f'],
    ]); checks++
    assert.deepStrictEqual(JSON.parse(JSON.stringify(si.buildExplorerDeleteOps())), [['delete', F, '/f'], ['delete', B, '/f']]); checks++
    check(si.explorerLabel('es') === 'Abrir en SnAgentsOS' && si.explorerLabel('en') === 'Open in SnAgentsOS', 'label localized in es and en')
    const out = (name, value) => `\r\nHKEY_CURRENT_USER\\Software\\Classes\\Directory\\shell\\SnAgentsOS\\command\r\n    ${name}    REG_SZ    ${value}\r\n\r\n`
    check(si.parseRegDefault(out('(Default)', '"C:\\a b\\x.exe" --open "%V"')) === '"C:\\a b\\x.exe" --open "%V"' && si.parseRegDefault(out('(Predeterminado)', 'Abrir en SnAgentsOS')) === 'Abrir en SnAgentsOS', 'reg query default value in any Windows language')
    check(si.parseRegDefault('\r\nHKEY_CURRENT_USER\\X\r\n') === null && si.parseRegDefault(out('(Default)', '')) === '', 'no value line is null; an empty value is empty')
    check(si.exeFromCommand('"C:\\a b\\x.exe" --open "%V"') === 'C:\\a b\\x.exe' && si.exeFromCommand('x.exe --open') === null && si.exeFromCommand(null) === null, 'exe from the registered command')
    check(si.sameExe('C:\\A\\x.exe', 'c:/a/X.EXE') && !si.sameExe('C:\\A\\x.exe', 'C:\\B\\x.exe') && !si.sameExe(null, 'x'), 'exe comparison ignores case and slash style')

    // In-memory reg.exe: add / delete (with subkeys) / query /ve.
    const fakeReg = () => {
      const keys = new Map()
      const calls = []
      let failAdd = false
      const run = async args => {
        calls.push(args)
        const [op, key] = args
        const k = key.toLowerCase()
        if (op === 'add') {
          if (failAdd) return { ok: false, stdout: '', stderr: 'ERROR: Access is denied.\r\n' }
          const vals = keys.get(k) ?? {}
          vals[args.includes('/ve') ? '' : args[args.indexOf('/v') + 1]] = args[args.indexOf('/d') + 1]
          keys.set(k, vals)
          return { ok: true, stdout: '', stderr: '' }
        }
        if (op === 'delete') {
          const hit = [...keys.keys()].filter(x => x === k || x.startsWith(k + '\\'))
          hit.forEach(x => keys.delete(x))
          return hit.length ? { ok: true, stdout: '', stderr: '' } : { ok: false, stdout: '', stderr: 'ERROR: not found' }
        }
        const vals = keys.get(k)
        if (!vals || !('' in vals)) return { ok: false, stdout: '', stderr: 'ERROR: not found' }
        return { ok: true, stdout: out('(Default)', vals['']), stderr: '' }
      }
      return { run, keys, calls, setFailAdd: v => { failAdd = v } }
    }
    const reg = fakeReg()
    const env = (over = {}) => ({ platform: 'win32', packaged: true, exe, root: si.EXPLORER_ROOT, run: reg.run, ...over })
    const skipNW = await si.applyExplorerMenu(true, 'es', env({ platform: 'linux' }))
    const skipDev = await si.readExplorerMenu(env({ packaged: false }))
    check(skipNW.skipped === 'not-windows' && skipNW.ok && !skipNW.registered && skipDev.skipped === 'dev' && reg.calls.length === 0, 'not Windows / dev: skipped without touching the registry')
    check(await si.refreshExplorerMenuOnStartup(true, 'es', env({ packaged: false })) === null && await si.refreshExplorerMenuOnStartup(false, 'es', env()) === null && reg.calls.length === 0, 'startup refresh does nothing in dev or with the toggle off')

    let res = await si.applyExplorerMenu(true, 'es', env())
    check(res.ok && res.registered && res.exe === exe && res.currentExe === exe && res.mismatch === false && !res.error, 'enable registers this exe')
    check(reg.keys.get(F.toLowerCase())[''] === 'Abrir en SnAgentsOS' && reg.keys.get((B + '\\command').toLowerCase())[''] === '"' + exe + '" --open "%V"', 'both keys written')
    res = await si.readExplorerMenu(env({ exe: 'D:\\Portable\\SnAgentsOS-2.0.0-portable.exe' }))
    check(res.registered && res.mismatch === true && res.exe === exe && res.currentExe === 'D:\\Portable\\SnAgentsOS-2.0.0-portable.exe', 'another exe sees the mismatch')

    reg.calls.length = 0
    res = await si.refreshExplorerMenuOnStartup(true, 'es', env())
    check(res && res.registered && !res.mismatch && !reg.calls.some(a => a[0] === 'add'), 'startup refresh with nothing changed writes nothing')
    res = await si.refreshExplorerMenuOnStartup(true, 'en', env())
    check(res && reg.keys.get(F.toLowerCase())[''] === 'Open in SnAgentsOS' && reg.keys.get(B.toLowerCase())[''] === 'Open in SnAgentsOS', 'a language change rewrites the label')
    const moved = 'E:\\Moved\\SnAgentsOS-2.0.0-portable.exe'
    res = await si.refreshExplorerMenuOnStartup(true, 'en', env({ exe: moved }))
    check(res.exe === moved && !res.mismatch && reg.keys.get((F + '\\command').toLowerCase())[''] === '"' + moved + '" --open "%V"', 'a moved portable rewrites the command (last started wins)')
    reg.keys.delete((B + '\\command').toLowerCase())
    reg.calls.length = 0
    await si.refreshExplorerMenuOnStartup(true, 'en', env({ exe: moved }))
    check(reg.calls.some(a => a[0] === 'add') && reg.keys.has((B + '\\command').toLowerCase()), 'a missing background key is restored')

    res = await si.applyExplorerMenu(false, 'en', env({ exe: moved }))
    check(res.ok && !res.registered && reg.keys.size === 0, 'disable removes both keys with their subkeys')
    res = await si.applyExplorerMenu(false, 'en', env())
    check(res.ok && !res.registered && !res.error, 'disabling twice is fine (missing keys are the goal)')
    reg.setFailAdd(true)
    res = await si.applyExplorerMenu(true, 'es', env())
    check(!res.ok && !res.registered && res.error === 'ERROR: Access is denied.', 'a failed write reports the reg.exe error')
    reg.setFailAdd(false)

    // Real reg.exe round trip, only on Windows, under a throwaway key.
    if (process.platform === 'win32') {
      const root = 'HKCU\\Software\\SnAgentsOSTest-' + require('node:crypto').randomBytes(6).toString('hex')
      const realEnv = over => ({ platform: 'win32', packaged: true, exe, root, run: si.runReg, ...over })
      try {
        res = await si.applyExplorerMenu(true, 'es', realEnv())
        check(res.ok && res.registered && res.exe === exe && res.mismatch === false, 'reg.exe: enable under the test root')
        const q = async (key, args) => si.parseRegDefault((await si.runReg(['query', key, ...args])).stdout)
        const keys = si.explorerKeys(root)
        check(await q(keys.folder + '\\command', ['/ve']) === '"' + exe + '" --open "%V"' && await q(keys.background + '\\command', ['/ve']) === '"' + exe + '" --open "%V"', 'reg.exe: the command keeps its quotes and %V through execFile')
        check(await q(keys.folder, ['/v', 'Icon']) === '"' + exe + '",0' && await q(keys.folder, ['/ve']) === 'Abrir en SnAgentsOS', 'reg.exe: icon and label')
        res = await si.readExplorerMenu(realEnv({ exe: 'D:\\Other\\SnAgentsOS.exe' }))
        check(res.mismatch === true, 'reg.exe: mismatch from another exe')
        res = await si.applyExplorerMenu(false, 'es', realEnv())
        check(res.ok && !res.registered && (await si.runReg(['query', keys.folder])).ok === false && (await si.runReg(['query', keys.background])).ok === false, 'reg.exe: disable removes both keys')
      } finally {
        await si.runReg(['delete', root, '/f'])
      }
      check((await si.runReg(['query', root])).ok === false, 'reg.exe: test root removed')
    }
  }

  // --- NSIS customUnInstall (E4-FR-35), statically -----------------------------
  {
    const fs = require('node:fs')
    const { BRAND } = load('src/shared/brand.ts')
    const si = load('src/main/shellIntegration.ts')
    const code = fs.readFileSync(path.join(root, 'build/installer.nsh'), 'utf8').split(/\r?\n/).map(l => l.replace(/^\s*[;#].*$/, '').trim()).filter(Boolean)
    const starts = code.flatMap((l, i) => l === '!macro customUnInstall' ? [i] : [])
    check(starts.length === 1, 'installer.nsh defines customUnInstall once')
    const block = code.slice(starts[0], code.indexOf('!macroend', starts[0]) + 1)
    const keys = si.explorerKeys(si.EXPLORER_ROOT)
    const rel = k => k.replace(/^HKCU\\/, '')
    check(block[1] === '${IfNot} ${isUpdated}' && block.at(-2) === '${EndIf}', 'an update never removes the keys')
    const read = block.findIndex(l => l.startsWith('ReadRegStr'))
    check(block.indexOf('SetShellVarContext current') > 0 && block.indexOf('SetShellVarContext current') < read && block.join('\n').includes('${If} $installMode == "all"\nSetShellVarContext all\n${EndIf}'), 'keys read in the user hive (SHCTX current), all-users context restored')
    check(block[read] === `ReadRegStr $R0 SHCTX "${rel(keys.folder)}\\command" ""` && rel(keys.folder).endsWith('\\' + BRAND.productName), 'reads the registered command of the app key')
    check(block.includes('StrCpy $R1 `"$INSTDIR\\`'), 'needle is the quoted install folder with its separator')
    const gate = block.indexOf('${If} $R5 == "1"')
    const dels = block.flatMap((l, i) => l.startsWith('DeleteRegKey') ? [i] : [])
    check(gate > read && dels.length === 2 && dels.every(i => i > gate && i < gate + 3), 'deletes only inside the containment gate')
    assert.deepStrictEqual([...dels.map(i => block[i])], [`DeleteRegKey SHCTX "${rel(keys.folder)}"`, `DeleteRegKey SHCTX "${rel(keys.background)}"`]); checks++
  }

  // --- fuzzyRank (app 2.7.0, A2; the palette ranks with it in A6) -------------
  {
    const { rankMatch: rm, rankList, foldSearchText } = load('src/shared/fuzzyRank.ts')
    // Each rank.
    check(rm('settings', 'Settings') === 4 && rm('Claude Code', 'claude code') === 4, 'exact (any case) scores 4')
    check(rm('sett', 'Settings') === 3 && rm('code', 'Claude Code') === 3 && rm('uno', 'Consola: Claude · Uno') === 3 && rm('main', 'feat/main') === 3, 'prefix of the text or of a word scores 3')
    check(rm('ings', 'Settings') === 2 && rm('ude', 'Consola: Claude') === 2 && rm('set', 'Reset view') === 2, 'substring scores 2 (a match inside a word is not a prefix)')
    check(rm('stgs', 'Settings') === 1 && rm('wkspc', 'Nuevo workspace') === 1, 'subsequence of a 4+ character term scores 1')
    check(rm('stg', 'Settings') === 0 && rm('nws', 'Nuevo workspace') === 0, 'a subsequence of a term shorter than 4 is rejected')
    check(rm('xyzw', 'Settings') === 0 && rm('settingsx', 'Settings') === 0 && rm('a', '') === 0, 'no match scores 0')
    // Accents and case.
    check(rm('configuracion', 'Configuración') === 4 && rm('CONFIGURACIÓN', 'configuracion') === 4 && rm('nino', 'Niño') === 4, 'accents and case are ignored both ways')
    check(rm('pájaro', 'El pajaro voló') === 3 && rm('volo', 'El pájaro voló') === 3 && rm('accion', 'Requiere tu intervención o acción') === 3, 'accented words match as words')
    check(foldSearchText('  Árbol   Ñandú ') === 'arbol nandu', 'folding: lower case, no accents, single spaces, trimmed')
    // Several terms: all must match, the score is the lowest; the whole query equal to the text is exact.
    check(rm('claude code', 'Claude Code') === 4 && rm('  claude   code ', 'Claude  Code') === 4, 'a multi-term query equal to the text is exact (spaces collapsed)')
    check(rm('code claude', 'Claude Code') === 3, 'terms match in any order (both prefixes: 3)')
    check(rm('cla ode', 'Claude Code') === 2 && rm('clde code', 'Claude Code') === 1, 'the score is the lowest term (prefix + substring = 2, subsequence + prefix = 1)')
    check(rm('claude zzz', 'Claude Code') === 0 && rm('clde cd', 'Claude Code') === 0, 'one term that does not match gives 0 (a short subsequence included)')
    // Empty query.
    check(rm('', 'anything') === 4 && rm('   ', '') === 4 && rm(undefined, 'x') === 4, 'an empty query matches everything with 4')

    // rankList: score desc, then input order; 0 dropped.
    const labels = ['Reset view', 'Settings', 'Asset folder', 'Open settings', 'Sxexxt', 'Settings']
    const ranked = rankList(labels.map((label, i) => ({ label, i })), 'set', (x) => x.label)
    check(ranked.map(x => x.i).join() === '1,3,5,0,2', 'rankList: prefixes (3) first, then substrings (2), each in input order; no match dropped (got ' + ranked.map(x => x.i).join() + ')')
    const many = Array.from({ length: 50 }, (_, i) => 'item ' + i)
    check(rankList(many, 'item', (x) => x).join() === many.join(), 'rankList is stable across 50 equal scores')
    const all = rankList(labels, '  ', (x) => x)
    check(all.join() === labels.join() && all !== labels, 'an empty query returns every item in order (a copy)')
    check(rankList([], 'x', (x) => x).length === 0, 'no items, no rows')
    // Several texts per item: the best one counts; empty texts are skipped.
    const cmds = [
      { id: 'a', label: 'Consola: Claude · Uno', search: 'fix login bug' },
      { id: 'b', label: 'Login', search: undefined },
      { id: 'c', label: 'Consola: Codex · Dos', search: null },
      { id: 'd', label: 'Tema: Login azul', search: '' },
    ]
    const texts = (c) => [c.label, c.search]
    check(rankList(cmds, 'login', texts).map(c => c.id).join() === 'b,a,d', 'several texts: the best one counts (exact label 4, then the word prefixes in input order)')
    check(rankList(cmds, 'fix login', texts).map(c => c.id).join() === 'a', 'every term has to match inside one text')
    check(rankList(cmds, 'dos', texts).map(c => c.id).join() === 'c', 'null and empty texts are skipped')
  }

  console.log(`PASS: ${checks} desktop comfort checks (toast stack, revealPane, in-app agent cards, phone notices, pty lifecycle, update state, settings search, key chips, wizard keys, open requests, Explorer menu, fuzzy ranking)`)
}

main().catch(error => { console.error(error); process.exitCode = 1 })
