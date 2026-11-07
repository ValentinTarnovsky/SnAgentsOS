// App 2.11.0 (Labs voice): the renderer's hands-free controller with a fake
// snApi. Wake word gating, selection by name and number (revealPane and
// setActive), the armed follow-up, dictation into a buffer that reaches the
// console only on an explicit send (pty.submit with userGate) or insert,
// cancel writing nothing, the Enter rule refusals (a waiting console, a menu
// on screen, main's awaiting_user) said out loud with the buffer kept,
// half-duplex while the voice speaks, the ambiguous-name question, and that
// the controller never sends text to say (phrase keys and ids only).
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
const flush = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }

function loadRenderer(contents, overrides = {}) {
  const code = buildSync({ stdin: { contents, resolveDir: path.join(root, 'src/renderer/lib'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, define: { 'process.env.NODE_ENV': '"production"' } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, crypto: globalThis.crypto, setTimeout, clearTimeout, URL, TextEncoder, requestAnimationFrame: () => 0, cancelAnimationFrame: () => {}, ...overrides })
  return mod.exports
}

function rig() {
  const calls = { cmd: [], submit: [], write: [], mode: [], roster: [] }
  const window = {
    snApi: {
      voice: {
        cmd: async (c) => { calls.cmd.push(c); return { ok: true } },
        mode: (m) => calls.mode.push(m),
        roster: (r) => calls.roster.push(r),
        setActive: async () => ({ ok: true }),
        onEvent: () => () => {},
        onPlay: () => () => {},
        played: () => {},
      },
      pty: {
        submit: async (req) => { calls.submit.push(req); return rig.submitResult ?? { ok: true } },
        write: (req) => calls.write.push(req),
      },
      dictation: { onEvent: () => () => {}, stop: async () => {}, start: async () => ({ ok: true, sessionId: 'hf1' }), audio: () => {} },
    },
  }
  const R = loadRenderer(`
    export * from './handsFree'
    export { useAppStore } from './store'
    export { registerPty } from './ptyRegistry'
    export { registerTermReader } from './termReaders'
  `, { window })
  const ws = (id, name, panes) => ({ id, name, cwd: 'C:/x', panes: panes.map(([pid, title]) => ({ id: pid, type: 'claude', title, color: '#fff', icon: 'claude' })) })
  R.useAppStore.setState({
    workspaces: [ws('w1', 'SnLib', [['p1', 'API'], ['p2', 'Pagos']]), ws('w2', 'MineBosh', [['p3', 'Gens'], ['p4', 'API Gateway']])],
    activeWorkspaceId: 'w1',
    settings: { ...R.useAppStore.getState().settings, language: 'es', labs: { consoleChat: false, teams: false, voice: true } },
  })
  for (const p of ['p1', 'p2', 'p3', 'p4']) R.registerPty(p, 'pty-' + p)
  R.__resetHandsFreeForTests()
  R.__setRosterForTests(R.currentRoster())
  R.useHandsFreeStore.setState({ phase: 'listening' })
  const says = () => calls.cmd.filter((c) => c.kind === 'say').map((c) => c.key + (c.paneId ? ':' + c.paneId : '') + (c.workspaceId ? ':' + c.workspaceId : ''))
  return { R, calls, says, st: () => R.useHandsFreeStore.getState(), app: () => R.useAppStore.getState() }
}

async function main() {
  {
    const h = rig()
    const { R } = h
    check(h.R.currentRoster().workspaces.map((w) => w.label + ':' + w.panes.map((p) => p.label).join('|')).join(' ; ') === 'SnLib:API|Pagos ; MineBosh:Gens|API Gateway', 'the roster: workspaces in sidebar order, consoles by their titles')
    R.onPhrase('consola dos')
    R.onPhrase('la gente está loca, consola dos')
    await flush()
    check(h.calls.cmd.length === 0, 'no wake word: nothing happens (Discord and the game are ignored)')
    R.onPhrase('Agente, consola dos')
    await flush()
    check(h.st().target === 'p2' && h.app().activeWorkspaceId === 'w1' && h.says().at(-1) === 'console:p2', 'Agente, consola dos: reveals the second console and says its name (by id)')
    R.onPhrase('Agente, workspace MineBosh')
    await flush()
    check(h.app().activeWorkspaceId === 'w2' && h.says().at(-1) === 'workspace:w2', 'Agente, workspace MineBosh: switches workspace')
    R.onPhrase('Agente, Gens')
    await flush()
    check(h.st().target === 'p3' && h.says().at(-1) === 'console:p3', 'a bare name selects that console')
    R.onPhrase('Agente, cocina')
    await flush()
    check(h.says().at(-1) === 'notFound', 'an unknown name: notFound')
    R.onPhrase('Agente, ah bueno qué tal todo por ahí')
    await flush()
    check(h.says().at(-1) === 'notUnderstood', 'a long phrase that is no command: notUnderstood')
    // Armed follow-up.
    R.onPhrase('Agente.')
    await flush()
    check(h.st().phase === 'armed' && h.says().at(-1) === 'yes', 'a bare wake word arms the follow-up window ("¿Sí?")')
    R.onPhrase('consola uno')
    await flush()
    check(h.st().phase === 'listening' && h.st().target === 'p3' && h.says().at(-1) === 'console:p3', 'the next phrase is a command without the wake word ("consola uno" of the active MineBosh)')
    // Dictation: the buffer, then an explicit send.
    R.onPhrase('Agente, dictale a pagos')
    await flush()
    check(h.st().phase === 'dictating' && h.st().target === 'p2' && h.calls.mode.at(-1) === 'dictating' && h.says().at(-1) === 'dictating:p2', 'dictale a pagos: dictating mode on that console')
    R.onPhrase('Arreglá el login')
    R.onPhrase('y corré los tests, agente, enviar')
    await flush()
    const sub = h.calls.submit.at(-1)
    check(sub && sub.paneId === 'p2' && sub.ptyId === 'pty-p2' && sub.text === 'Arreglá el login y corré los tests' && sub.enter === true && sub.userGate === true, 'the trailing "agente, enviar" sends the whole buffer once, with userGate (got ' + JSON.stringify(sub) + ')')
    check(h.calls.write.length === 0 && h.st().buffer === '' && h.st().phase === 'listening' && h.says().at(-1) === 'sent:p2', 'nothing was typed before the send; the buffer is empty after it')
    // Insert and cancel.
    R.run({ kind: 'dictate' })
    R.onPhrase('solo escribilo')
    R.onPhrase('insertar')
    await flush()
    check(h.calls.submit.at(-1).enter === false && h.calls.submit.at(-1).text === 'solo escribilo' && h.says().at(-1) === 'inserted:p2', 'a bare "insertar" while dictating types it without Enter')
    const n = h.calls.submit.length
    R.run({ kind: 'dictate' })
    R.onPhrase('esto no va')
    R.onPhrase('cancelar')
    await flush()
    check(h.calls.submit.length === n && h.calls.write.length === 0 && h.st().buffer === '' && h.says().at(-1) === 'cancelled', 'cancelar drops the buffer and writes nothing')
    R.onPhrase('hay que enviar')
    await flush()
    check(h.calls.submit.length === n, 'outside dictation "hay que enviar" is nothing (no wake word)')
    // The Enter rule.
    R.run({ kind: 'dictate' })
    R.onPhrase('corré los tests')
    R.useAppStore.getState().setPaneStatus({ paneId: 'p2', state: 'action', precise: true, notify: false, reason: 'permission', pendingCount: 1, attention: true, pending: [{ id: 'q', kind: 'permission', summary: 'Bash' }] })
    R.onPhrase('enviar')
    await flush()
    check(h.calls.submit.length === n && h.st().buffer === 'corré los tests' && h.says().at(-1) === 'awaitingUser:p2', 'a console waiting on a permission: refused out loud, the buffer kept, nothing sent')
    R.useAppStore.getState().setPaneStatus({ paneId: 'p2', state: 'working', precise: true, notify: false, pendingCount: 0, attention: false })
    R.registerTermReader('p2', () => ['Do you want to proceed?', '❯ 1. Yes', '  2. No'])
    R.onPhrase('enviar')
    await flush()
    check(h.calls.submit.length === n && h.says().at(-1) === 'awaitingUser:p2', 'a numbered menu on screen: refused too')
    R.registerTermReader('p2', () => ['$ '])
    rig.submitResult = { ok: false, error: 'awaiting_user' }
    R.onPhrase('enviar')
    await flush()
    check(h.calls.submit.length === n + 1 && h.st().buffer === 'corré los tests' && h.says().at(-1) === 'awaitingUser:p2', "main's awaiting_user: said, the buffer kept")
    rig.submitResult = undefined
    R.onPhrase('enviar')
    await flush()
    check(h.calls.submit.at(-1).text === 'corré los tests' && h.says().at(-1) === 'sent:p2', 'once the console is free the same buffer goes')
    // Half-duplex.
    R.run({ kind: 'dictate' })
    R.useHandsFreeStore.setState({ speaking: true })
    R.onPhrase('esto lo dijo el parlante')
    check(h.st().buffer === '', 'while the voice speaks a phrase without the wake word is dropped (the speakers echo)')
    R.onPhrase('Agente, callate')
    await flush()
    check(h.calls.cmd.at(-1).kind === 'stop', 'a phrase with the wake word still works (barge-in)')
    R.useHandsFreeStore.setState({ speaking: false })
    R.onPhrase('cancelar')
    await flush()
    // Ambiguous names.
    R.useAppStore.getState().setActive('w1')
    R.onPhrase('Agente, consola api')
    await flush()
    check(h.st().target === 'p1', 'API inside the active workspace is not ambiguous')
    R.useAppStore.getState().setActive('w2')
    R.__setRosterForTests({ workspaces: [{ id: 'w1', label: 'SnLib', panes: [{ id: 'p1', label: 'API' }] }, { id: 'w2', label: 'MineBosh', panes: [{ id: 'p3', label: 'Pagos uno' }, { id: 'p4', label: 'Pagos dos' }] }] })
    R.onPhrase('Agente, consola pagos')
    await flush()
    const amb = h.calls.cmd.at(-1)
    check(h.st().phase === 'confirming' && amb.key === 'ambiguous' && amb.options.length === 2 && h.calls.mode.at(-1) === 'confirming', 'two consoles named alike: main asks which one (by ids)')
    R.onPhrase('la segunda')
    await flush()
    check(h.st().phase === 'listening' && h.st().target === amb.options[1], 'la segunda picks the second option')
    R.__setRosterForTests(R.currentRoster())
    // Reading and the rest go to main as commands with ids.
    R.onPhrase('Agente, leé Gens')
    await flush()
    check(JSON.stringify(h.calls.cmd.at(-1)) === '{"kind":"read","paneId":"p3"}', 'leé Gens reads that console (main resolves nothing from text)')
    R.onPhrase('Agente, siguiente')
    R.onPhrase('Agente, cómo van')
    R.onPhrase('Agente, repetí')
    await flush()
    check(h.calls.cmd.slice(-3).map((c) => c.kind).join() === 'next,status,repeat', 'siguiente, cómo van, repetí')
    check(h.calls.cmd.every((c) => c.kind !== 'say' || Object.keys(c).every((k) => ['kind', 'key', 'paneId', 'workspaceId', 'options'].includes(k))), 'every say is a key with ids: no text is ever sent to be spoken')
    // A held dictation.
    R.useHandsFreeStore.setState({ phase: 'off', held: { paneId: 'p1', text: 'pendiente' } })
    R.sendHeld(true)
    await flush()
    check(h.calls.submit.at(-1).paneId === 'p1' && h.calls.submit.at(-1).text === 'pendiente' && h.st().held === null, 'a held dictation sent from the dock')
  }
  console.log(`PASS: ${checks} voice renderer checks (wake gating, selection, follow-up, dictation buffer and explicit send, cancel, Enter rule refusals, half-duplex, ambiguous names, commands with ids only)`)
}

main().catch((e) => { console.error(e); process.exit(1) })
