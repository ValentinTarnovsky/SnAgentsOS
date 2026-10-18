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
    pm.killAll()

    // The IPC: a malformed reconcile list never reads as "no panes".
    const handlers = {}
    const { registerPtyIpc } = load('src/main/ipc/registerPtyIpc.ts', {
      require: id => id === 'electron' ? { ipcMain: { handle: (ch, fn) => { handlers[ch] = fn }, on: (ch, fn) => { handlers[ch] = fn } } } : require(id),
    })
    const calls = []
    registerPtyIpc({ killPanes: ids => { calls.push(['kill', ids]); return ids.length }, reconcile: ids => { calls.push(['rec', ids]); return 0 } })
    check(handlers['pty:killPanes'](null, ['x', 7, 'y']) === 2 && calls[0][1].join() === 'x,y', 'pty:killPanes keeps only string ids')
    check(handlers['pty:reconcile'](null, 'nope') === 0 && calls.length === 1, 'pty:reconcile ignores a non-array payload instead of killing everything')
    handlers['pty:reconcile'](null, ['x'])
    check(calls[1][0] === 'rec' && calls[1][1].join() === 'x', 'pty:reconcile forwards the live list')
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

    S.getState().removePane('w1', 'p2')
    check(killCalls.length === 1 && killCalls[0].join() === 'p2', 'removePane kills exactly the removed pane')

    // A workspace never visited after a reload: the renderer registry is empty,
    // the kill still goes by paneId to main.
    check(r.getPtyId('q1') === undefined, 'unvisited workspace has no local pty binding')
    killCalls.length = 0
    S.getState().deleteWorkspace('w2')
    const killed = new Set(killCalls.flat())
    check(killed.has('q1') && killed.has('q2') && killed.size === 2, 'deleteWorkspace kills every pane of an unvisited workspace by paneId')

    killCalls.length = 0
    S.getState().importConfig({ workspaces: [
      { id: 'w1', name: 'Uno', cwd: '', panes: [pane('p1')] },
      { id: 'w9', name: 'Nueva', cwd: '', panes: [pane('n1')] },
    ] })
    check(killCalls.length === 1 && killCalls[0].join() === 't1', 'importConfig kills only the panes that disappear')

    killCalls.length = 0
    S.getState().mergeConfig({ workspaces: [{ id: 'm', name: 'M', cwd: '', panes: [pane('m1')] }] })
    check(killCalls.length === 0, 'mergeConfig adds panes and kills nothing')

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

  console.log(`PASS: ${checks} desktop comfort checks (toast stack, revealPane, in-app agent cards, phone notices, pty lifecycle)`)
}

main().catch(error => { console.error(error); process.exitCode = 1 })
