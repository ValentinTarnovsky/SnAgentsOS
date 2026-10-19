// Desktop half of the phone's Home (E2-FR-06, 07, 10, 11, 12; R22-14): the
// renderer executor (createPane with a prompt and its promptFallback
// prediction, the partial mount that never moves the desktop, mountWorkspace,
// revealPane, openUrl) and the snapshot fields the phone needs (presets,
// mountedWorkspaceIds). Same esbuild + vm harness as test-automation.cjs, with
// a fake window.snApi: no Electron, no network, no personal config.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }

function loadRenderer(contents, overrides = {}) {
  const code = buildSync({ stdin: { contents, resolveDir: path.join(root, 'src/renderer/lib'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, define: { 'process.env.NODE_ENV': '"production"' } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, crypto: globalThis.crypto, setTimeout, clearTimeout, URL, ...overrides })
  return mod.exports
}

const baseSettings = { defaultShell: {}, fontFamily: 'mono', fontSize: 13, scrollback: 1000, restoreLastWorkspace: true, confirmCloseRunning: true, sidebarCollapsed: false, language: 'es' }
const claude = { id: 'preset-claude', name: 'Claude Code', type: 'claude', command: 'claude', args: ['--secret-flag'], env: { TOKEN: 'x' }, color: '#d97757', icon: 'claude' }
const codex = { id: 'preset-codex', name: 'Codex', type: 'codex', command: 'codex', args: [], color: '#10a37f', icon: 'codex' }
const shell = { id: 'preset-shell', name: 'Shell', type: 'shell', command: '', args: [], color: '#888888', icon: 'terminal' }
const config = () => ({
  version: 12,
  workspaces: [
    { id: 'w1', name: 'Uno', cwd: 'C:/a', panes: [{ id: 'p1', type: 'shell', title: 'Shell', color: '#fff', icon: 'terminal' }] },
    { id: 'w2', name: 'Dos', cwd: 'C:/b', panes: [{ id: 'q1', type: 'claude', title: 'Claude', color: '#fff', icon: 'claude' }, { id: 'q2', type: 'shell', title: 'Sh', color: '#fff', icon: 'terminal' }] },
    { id: 'w3', name: 'SSH', cwd: '/srv', setupId: 'conn-1', panes: [] },
  ],
  presets: [claude, codex, shell],
  connections: [{ id: 'conn-1', name: 'Server', steps: [{ expect: '$', send: 'ssh host' }] }],
  settings: { ...baseSettings },
  activeWorkspaceId: 'w1',
})

async function main() {
  const calls = { reveal: 0, open: [], results: [], states: [] }
  const snApi = {
    platform: 'win32',
    config: { save() {} },
    pty: { killPanes: async () => 0, submit: async () => ({ ok: true }) },
    window: { reveal: () => { calls.reveal++ } },
    system: { openExternal: (url) => calls.open.push(url) },
    remote: { onCommand: (cb) => { snApi._cmd = cb; return () => {} }, commandResult: (res) => calls.results.push(res), pushState: (st) => calls.states.push(st) },
    clipboard: { writeText() {} },
  }
  const r = loadRenderer(`
    export { useAppStore } from './store'
    export { initRemoteCommands, remotePromptFallback } from './remoteCommands'
    export { startRemoteSnapshotSync, fullyMountedIds } from './remoteSnapshot'
    export { freezeSidebarOrder, releaseSidebarOrder } from './sidebarOrder'
  `, { window: { snApi }, document: { hasFocus: () => true, querySelector: () => null }, requestAnimationFrame: () => 0, cancelAnimationFrame() {} })
  const S = r.useAppStore
  S.getState().hydrate(config())
  r.initRemoteCommands()
  const ctl = async (action) => { snApi._cmd({ id: `c${calls.results.length}`, action }); await new Promise((res) => setImmediate(res)); return calls.results.at(-1) }
  const ws = (id) => S.getState().workspaces.find((w) => w.id === id)
  const pending = (id) => S.getState().pendingPrompts[id]

  // --- createPane with a prompt (E2-FR-10/11) ---
  let ack = await ctl({ kind: 'createPane', workspaceId: 'w2', presetId: 'preset-claude', prompt: 'explica "x" y $HOME' })
  check(ack.ok && ack.paneId && ws('w2').panes.some((p) => p.id === ack.paneId && p.presetId === 'preset-claude'), 'createPane adds the preset console to the phone workspace and acks its id')
  check(!ack.promptFallback, 'a PowerShell prompt without % goes on the command line (no promptFallback)')
  check(pending(ack.paneId).text === 'explica "x" y $HOME' && pending(ack.paneId).mode === 'argvOnly' && pending(ack.paneId).source === 'remote' && pending(ack.paneId).enter === true, 'the prompt waits for the spawn in argvOnly mode (never typed by the gate)')
  check(S.getState().activeWorkspaceId === 'w1', 'the desktop keeps its active workspace')
  const mount = S.getState().mountedWorkspaces.w2
  check(Array.isArray(mount) && mount.length === 1 && mount[0] === ack.paneId, 'only the new console mounts (partial mount), so its pty starts without moving the desktop')
  ack = await ctl({ kind: 'createPane', workspaceId: 'w2', presetId: 'preset-codex', prompt: 'linea uno\nlinea dos\r\ntres' })
  check(!ack.promptFallback && pending(ack.paneId).text === 'linea uno linea dos tres', 'line breaks become spaces: the variable is one line (E2-FR-11)')
  ack = await ctl({ kind: 'createPane', workspaceId: 'w2', presetId: 'preset-claude', prompt: 'subi al 100%' })
  check(ack.ok && ack.promptFallback === true && !pending(ack.paneId), 'a % on win32 opens the console without the prompt and acks promptFallback')
  ack = await ctl({ kind: 'createPane', workspaceId: 'w2', presetId: 'preset-claude', prompt: 'a b '.repeat(800) })
  check(ack.promptFallback === true && !pending(ack.paneId), 'more than 2000 sanitized characters fall back')
  ack = await ctl({ kind: 'createPane', workspaceId: 'w3', presetId: 'preset-claude', prompt: 'hola' })
  check(ack.ok && ack.promptFallback === true && !pending(ack.paneId), 'a workspace with a Connection Profile (SSH) falls back')
  ack = await ctl({ kind: 'createPane', workspaceId: 'w2', presetId: 'preset-shell', prompt: 'ls' })
  check(ack.promptFallback === true && !pending(ack.paneId), 'a non-agent preset falls back')
  ack = await ctl({ kind: 'createPane', workspaceId: 'w2', presetId: 'preset-claude', prompt: '  \n ' })
  check(ack.ok && !ack.promptFallback && !pending(ack.paneId), 'a blank prompt is no prompt at all')
  ack = await ctl({ kind: 'createPane', workspaceId: 'w2' })
  check(ack.ok && ack.paneId && !ack.promptFallback && !pending(ack.paneId) && S.getState().mountedWorkspaces.w2.includes(ack.paneId), 'a plain createPane still mounts only the new console')
  ack = await ctl({ kind: 'createPane', workspaceId: 'gone', presetId: 'preset-claude', prompt: 'x' })
  check(!ack.ok && ack.error === 'not_found', 'an unknown workspace is not_found')

  // The prediction itself, per shell and platform.
  const st = S.getState()
  const w2 = ws('w2')
  const fb = (text, platform, defaultShell = {}) => r.remotePromptFallback({ ...st, settings: { ...st.settings, defaultShell } }, w2, claude, text, platform)
  check(!fb('revisa C:\\dir\\', 'win32'), 'default PowerShell on win32 takes argv (trailing backslash is sanitized away)')
  check(fb('hola', 'win32', { win32: 'C:\\tools\\nu.exe' }), 'an unknown shell (nu) falls back')
  check(!fb('hola', 'win32', { win32: 'C:\\Windows\\System32\\cmd.exe' }), 'cmd.exe takes argv')
  check(!fb('subi al 100%', 'linux'), 'a % is fine on a posix shell outside win32')
  check(!fb('hola', 'darwin', { darwin: '/opt/homebrew/bin/fish' }), 'fish is posix')
  check(r.remotePromptFallback(st, w2, undefined, 'x', 'win32'), 'no preset at all falls back')

  // --- mountWorkspace (E2-FR-06) ---
  ack = await ctl({ kind: 'mountWorkspace', workspaceId: 'w2' })
  check(ack.ok && S.getState().mountedWorkspaces.w2 === 'full' && ack.info === ws('w2').panes.length, 'mountWorkspace mounts every console of the workspace and reports how many')
  check(S.getState().activeWorkspaceId === 'w1', 'mounting never activates it')
  ack = await ctl({ kind: 'mountWorkspace', workspaceId: 'nope' })
  check(!ack.ok && ack.error === 'not_found', 'mountWorkspace of an unknown workspace is not_found')

  // --- revealPane (E2-FR-07) ---
  ack = await ctl({ kind: 'revealPane', paneId: 'nope' })
  check(!ack.ok && ack.error === 'not_found' && calls.reveal === 0, 'revealPane of an unknown pane is not_found and leaves the window alone')
  ack = await ctl({ kind: 'revealPane', paneId: 'q2' })
  check(ack.ok && calls.reveal === 1, 'revealPane asks main to restore, show and focus the window')
  check(S.getState().activeWorkspaceId === 'w2', 'and then reveals the console on the desktop (its workspace becomes active)')

  ack = await ctl({ kind: 'switchWorkspace', workspaceId: 'w1' })
  check(ack.ok && S.getState().activeWorkspaceId === 'w1' && calls.reveal === 2, 'switchWorkspace (the workspace kebab\'s "Show on the PC") activates it and brings the window up')

  // --- openUrl ---
  ack = await ctl({ kind: 'openUrl', url: 'http://localhost:5173/' })
  check(ack.ok && calls.open.at(-1) === 'http://localhost:5173/', 'openUrl opens an http link on the PC')
  ack = await ctl({ kind: 'openUrl', url: 'file:///C:/Windows/System32/calc.exe' })
  check(!ack.ok && ack.error === 'denied_url' && calls.open.length === 1, 'openUrl refuses a file: link with denied_url')
  for (const url of ['javascript:alert(1)', 'ms-settings:network', 'not a url', 'http://']) {
    ack = await ctl({ kind: 'openUrl', url })
    check(!ack.ok && ack.error === 'denied_url' && calls.open.length === 1, 'openUrl refuses ' + url)
  }
  ack = await ctl({ kind: 'openUrl', url: 'mailto:a@b.c' })
  check(ack.ok && calls.open.at(-1) === 'mailto:a@b.c', 'openUrl opens a mailto link')

  // --- snapshot (E2-FR-12) ---
  const stop = r.startRemoteSnapshotSync()
  const snap = calls.states.at(-1)
  check(snap.presets.map((p) => p.id).join() === 'preset-claude,preset-codex,preset-shell', 'the snapshot lists the presets in desktop order')
  check(snap.presets.every((p) => Object.keys(p).sort().join() === 'color,icon,id,name,type'), 'a preset travels as id, name, type, icon and color only (never command, args or env)')
  check(JSON.stringify(snap.mountedWorkspaceIds) === JSON.stringify(['w1', 'w2']), 'mountedWorkspaceIds lists the fully mounted workspaces')
  check(!('hostName' in snap), 'hostName is main\'s to add, not the renderer\'s')

  // --- sidebar order: the phone lists the workspaces exactly like the sidebar ---
  const order = () => calls.states.at(-1).workspaces.map((w) => w.id).join()
  const settle = () => new Promise((res) => setTimeout(res, 150))
  check(order() === 'w1,w2,w3', 'the snapshot starts in the sidebar order')
  S.getState().setWorkspaceOrder(['w3', 'w1', 'w2'])
  await settle()
  check(order() === 'w3,w1,w2', 'a drag reorder in the sidebar moves the workspace on the phone')
  S.getState().toggleFavorite('w2')
  await settle()
  check(order() === 'w2,w3,w1', 'a favorite goes first on the phone too')
  check(calls.states.at(-1).mountedWorkspaceIds.join() === 'w2,w1', 'mountedWorkspaceIds follows the same order')
  S.getState().updateSettings({ agents: { ...S.getState().settings.agents, sidebarSort: 'smart' } })
  await settle()
  check(order() === 'w2,w3,w1', 'smart order without agent states keeps the manual order inside each group')
  const now = Date.now()
  S.getState().setPaneStatus({ paneId: 'p1', state: 'action', precise: true, notify: false, provider: 'claude', reason: 'permission', pendingCount: 1, updatedAt: now, stateSince: now })
  await settle()
  check(order() === 'w2,w1,w3', 'smart order: a workspace whose agent needs action moves up (favorites still first)')
  r.freezeSidebarOrder(['w2', 'w3', 'w1'])
  await settle()
  check(order() === 'w2,w3,w1', 'while the sidebar is frozen the phone keeps the frozen order')
  r.releaseSidebarOrder()
  await settle()
  check(order() === 'w2,w1,w3', 'releasing the freeze pushes the live smart order')
  const pushes = calls.states.length
  S.getState().setPaneStatus({ paneId: 'p1', state: 'action', precise: true, notify: false, provider: 'claude', reason: 'permission', pendingCount: 1, updatedAt: now + 1, stateSince: now })
  await settle()
  check(calls.states.length === pushes, 'a status update that keeps the order pushes nothing')
  stop()
  check(JSON.stringify(r.fullyMountedIds({ a: 'full', b: ['x'], c: 'full' }, ['c', 'b', 'a', 'z'])) === '["c","a"]', 'a partial mount does not count as mounted; workspace order wins')

  // --- revealWindow (main, E2-FR-07) ---
  const rwCode = buildSync({ entryPoints: [path.join(root, 'src/main/window/revealWindow.ts')], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron'], alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
  const rwMod = { exports: {} }
  vm.runInNewContext(rwCode, { module: rwMod, exports: rwMod.exports, require })
  const fakeWin = ({ minimized = false, grantFocus = true } = {}) => {
    const log = []
    let focused = false
    return {
      log,
      isDestroyed: () => false,
      isMinimized: () => minimized,
      restore: () => { log.push('restore'); minimized = false },
      show: () => log.push('show'),
      focus: () => { log.push('focus'); focused = grantFocus },
      isFocused: () => focused,
      flashFrame: (on) => log.push('flash:' + on),
      webContents: { send: (ch, arg) => log.push(ch + ':' + arg) },
    }
  }
  let win = fakeWin({ minimized: true })
  check(rwMod.exports.revealWindow(win) === true && win.log.join() === 'restore,show,focus', 'a minimized window is restored, shown and focused (no flash when focus is granted)')
  win = fakeWin({ grantFocus: false })
  check(rwMod.exports.revealWindow(win) === false && win.log.join() === 'show,focus,flash:true', 'when Windows denies the focus the taskbar button flashes')
  win = fakeWin()
  rwMod.exports.revealWindow(win, 'p1')
  check(win.log.at(-1) === 'status:reveal:p1', 'with a paneId (notification click) the renderer is told to reveal it')
  check(rwMod.exports.revealWindow({ isDestroyed: () => true }) === false, 'a destroyed window is left alone')

  console.log(`PASS: ${checks} phone Home desktop checks`)
}

main().catch((error) => { console.error(error); process.exit(1) })
