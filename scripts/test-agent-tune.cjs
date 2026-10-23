// Model, effort and Ultracode from the phone (app 2.3.0, ctl agentTune).
// Pure module src/shared/agentTune.ts (commands, allowlist, Enter gate, the
// read-back hint and its IPC validation, the version gate), PtyManager's
// gated submit (`readyFor`: a ready agent with no unsent input in its box) and
// the renderer executor runAgentTune. esbuild + vm, like test-status.cjs.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const os = require('node:os')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron'], alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, setTimeout, clearTimeout, ...overrides })
  return mod.exports
}
function loadRenderer(contents, overrides = {}) {
  const code = buildSync({ stdin: { contents, resolveDir: path.join(root, 'src/renderer/lib'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, define: { 'process.env.NODE_ENV': '"production"' } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, crypto: globalThis.crypto, setTimeout, clearTimeout, ...overrides })
  return mod.exports
}

async function main() {
  const T = load('src/shared/agentTune.ts')
  const { REPORTS_ONLY_RE } = load('src/shared/inputReports.ts')

  // 1. tuneCommand: one allowlisted command per set.
  check(T.tuneCommand('claude', { kind: 'model', value: 'opus' }) === '/model opus', 'Claude model alias')
  check(T.tuneCommand('claude', { kind: 'model', value: 'opus[1m]' }) === '/model opus[1m]', 'Claude 1M alias')
  check(T.tuneCommand('claude', { kind: 'model', value: 'claude-opus-4-5-20251101' }) === '/model claude-opus-4-5-20251101', 'a full model id passes the regex')
  check(T.tuneCommand('claude', { kind: 'model', value: 'claude-sonnet-4-5[1m]' }) === '/model claude-sonnet-4-5[1m]', 'a full id with [1m]')
  for (const bad of ['gpt-5', 'opus; rm -rf', 'claude-x y', 'claude-x\n/exit', 'claude-' + 'a'.repeat(61), 'Claude-opus', '', 'claude-opus\r']) {
    check(T.tuneCommand('claude', { kind: 'model', value: bad }) === null, `model off the allowlist is refused: ${JSON.stringify(bad)}`)
  }
  check(T.tuneCommand('claude', { kind: 'effort', value: 'xhigh' }) === '/effort xhigh' && T.tuneCommand('claude', { kind: 'effort', value: 'auto' }) === '/effort auto', 'Claude effort levels and auto')
  check(T.tuneCommand('claude', { kind: 'effort', value: 'ultra' }) === null && T.tuneCommand('claude', { kind: 'effort', value: 'minimal' }) === null, 'Codex-only or unknown efforts are refused')
  check(T.tuneCommand('claude', { kind: 'ultracode', on: true }) === '/effort ultracode on' && T.tuneCommand('claude', { kind: 'ultracode', on: false }) === '/effort ultracode off', 'Ultracode on and off')
  check(T.tuneCommand('claude', { kind: 'picker' }) === '/model', 'Claude picker is the bare /model')
  check(T.tuneCommand('codex', { kind: 'picker' }) === '/model', 'Codex picker opens /model')
  check(['model', 'effort', 'ultracode'].every(kind => T.tuneCommand('codex', { kind, value: 'opus', on: true }) === null), 'Codex takes nothing but the picker')
  const id64 = 'claude-' + 'a'.repeat(53) + '[1m]', id65 = 'claude-' + 'a'.repeat(58)
  check(id64.length === 64 && T.isClaudeModel(id64) && id65.length === 65 && !T.isClaudeModel(id65), 'a full id is bounded at 64 like every model field')
  check(JSON.stringify(T.CLAUDE_EFFORTS) === '["low","medium","high","xhigh","max"]' && T.CLAUDE_MODELS.length === 8, 'the sheet lists 5 efforts and 8 models')

  // 2. tuneReady: precise, at rest, no request, the same provider.
  const ready = { state: 'idle', precise: true, provider: 'claude' }
  check(T.tuneReady(ready, 'claude') && T.tuneReady({ ...ready, state: 'done' }, 'claude'), 'idle and done are ready')
  check(!T.tuneReady({ ...ready, precise: false }, 'claude') && !T.tuneReady({ ...ready, precise: undefined }, 'claude'), 'a title-only (or unknown) signal never sends Enter')
  for (const state of ['working', 'action', 'error', 'unknown', null]) check(!T.tuneReady({ ...ready, state }, 'claude'), `${state} is not ready`)
  check(!T.tuneReady({ ...ready, pendingCount: 1 }, 'claude'), 'an open request is not ready')
  check(!T.tuneReady({ ...ready, ended: true }, 'claude') && T.tuneReady({ ...ready, ended: false }, 'claude'), 'an ended session (`/exit`, a bare shell now) is not ready')
  check(!T.tuneReady(ready, 'codex') && !T.tuneReady({ state: 'idle', precise: true }, 'claude') && !T.tuneReady(null, 'claude'), 'another provider, none, or no status is not ready')

  // 3. Read-back hint and its validation (status:tuneHint).
  check(JSON.stringify(T.tuneHintOf({ kind: 'model', value: 'opus' })) === '{"model":"opus"}', 'model hint')
  check(JSON.stringify(T.tuneHintOf({ kind: 'effort', value: 'auto' })) === '{"effort":"auto","ultracode":false}', '/effort auto turns Ultracode off')
  check(JSON.stringify(T.tuneHintOf({ kind: 'ultracode', on: true })) === '{"ultracode":true}' && T.tuneHintOf({ kind: 'picker' }) === null, 'Ultracode hint; the picker sets nothing')
  check(JSON.stringify(T.parseTuneHint({ paneId: 'p', model: 'opus', effort: 'high', ultracode: true })) === '{"paneId":"p","hint":{"model":"opus","effort":"high","ultracode":true}}', 'a valid hint passes')
  for (const bad of [null, 'x', {}, { paneId: '' }, { paneId: 'p' }, { paneId: 'p', model: 'gpt' }, { paneId: 'p', effort: 'ultra' }, { paneId: 'p', ultracode: 'yes' }, { paneId: 'p'.repeat(129), effort: 'low' }, { paneId: 7, effort: 'low' }, { paneId: 'p', model: 'claude-' + 'a'.repeat(58) }]) {
    check(T.parseTuneHint(bad) === null, `hint refused: ${JSON.stringify(bad)}`)
  }

  // 4. Which writes leave a draft in the input box.
  const isReport = d => REPORTS_ONLY_RE.test(d)
  check(T.inputEffect('fix the bug', isReport) === 'typed' && T.inputEffect('\x1b[A', isReport) === 'typed', 'text and arrows (history recall) may leave a draft')
  check(T.inputEffect('\r', isReport) === 'cleared' && T.inputEffect('hola\r', isReport) === 'cleared' && T.inputEffect('\x03', isReport) === 'cleared', 'Enter and Ctrl+C clear the box')
  check(T.inputEffect('\x1b\r', isReport) === 'typed' && T.inputEffect('a\\\r', isReport) === 'typed', 'Alt+Enter and backslash Enter add a line, not a submit')
  check(T.inputEffect('\r', isReport, '\\') === 'typed' && T.inputEffect('\r', isReport, 'x') === 'cleared' && T.inputEffect('ok\r', isReport, '\\') === 'cleared', 'a backslash typed as its own keystroke still turns the next Enter into a new line')
  check(T.inputEffect('\x1b', isReport) === 'report' && T.inputEffect('\x1b\x1b', isReport) === 'report', 'a lone Esc (interrupt) neither types nor clears')
  check(T.inputEffect('\x1b[I', isReport) === 'report' && T.inputEffect('\x1b[12;40R', isReport) === 'report' && T.inputEffect('', isReport) === 'report', 'terminal reports never count')

  // 5. Version gate of the phone.
  check(T.appVersionAtLeast('2.3.0') && T.appVersionAtLeast('2.3.1') && T.appVersionAtLeast('2.10.0') && T.appVersionAtLeast('3.0.0') && T.appVersionAtLeast('2.3.0-beta.1') && T.appVersionAtLeast('dev'), '2.3.0, later and dev desktops support agentTune')
  check(!T.appVersionAtLeast('2.2.1') && !T.appVersionAtLeast('1.9.9') && !T.appVersionAtLeast('') && !T.appVersionAtLeast(undefined) && !T.appVersionAtLeast('test'), 'older, empty or unparsable versions do not')
  check(T.APP_2_4_0 === '2.4.0' && T.appVersionAtLeast('2.4.0', T.APP_2_4_0) && T.appVersionAtLeast('2.10.0', T.APP_2_4_0) && T.appVersionAtLeast('dev', T.APP_2_4_0) && !T.appVersionAtLeast('2.3.0', T.APP_2_4_0) && !T.appVersionAtLeast(undefined, T.APP_2_4_0), 'APP_2_4_0 gates the 2.4.0 phone features')

  // 6. PtyManager: the gated submit (readyFor) and the draft tracking.
  {
    const writes = []
    const impl = (_shell, _args, opts) => ({ cols: opts.cols, rows: opts.rows, onData() {}, onExit() {}, write: d => writes.push(d), resize() {}, pause() {}, resume() {}, kill() {} })
    const code = buildSync({ entryPoints: [path.join(root, 'src/main/pty/PtyManager.ts')], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'node-pty', '@xterm/headless', '@xterm/addon-serialize', '@xterm/addon-unicode11'], alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
    const mod = { exports: {} }
    vm.runInNewContext(code, { module: mod, exports: mod.exports, Buffer, process, setTimeout, clearTimeout, setInterval, clearInterval, console: { ...console, warn() {} },
      require: id => id === 'node-pty' ? { spawn: impl } : id === 'electron' ? { app: { getPath: () => os.tmpdir() } } : require(id) })
    let st = { state: 'idle', precise: true, provider: 'claude' }
    const pm = new mod.exports.PtyManager(() => ({ isDestroyed: () => false, send() {} }), () => ({}), () => st)
    pm.spawn({ paneId: 'p', cols: 80, rows: 24 })
    const ptyId = pm.ptyIdForPane('p')
    writes.length = 0
    let res = await pm.submitToPane('', 'p', '/effort high', true, 'user', 'claude')
    check(res.ok && writes.join('|') === '/effort high|\r', 'a ready agent with a clean box gets the command and its Enter')
    writes.length = 0
    pm.write(ptyId, 'fix the bug')
    res = await pm.submitToPane('', 'p', '/effort high', true, 'user', 'claude')
    check(!res.ok && res.error === 'busy' && writes.join('|') === 'fix the bug', 'unsent text in the box: busy, and nothing is written')
    res = await pm.submitToPane('', 'p', '/effort high', false, 'user', 'claude')
    check(res.ok && writes.at(-1) === '/effort high', 'without Enter the gate does not apply (an insert)')
    pm.write(ptyId, '\x03'); writes.length = 0
    res = await pm.submitToPane(ptyId, 'p', '/model opus', true, 'user', 'claude')
    check(res.ok && writes.join('|') === '/model opus|\r', 'Ctrl+C cleared the box: ready again')
    pm.write(ptyId, '\x1b[I'); pm.write(ptyId, '\x1b[3;1R')
    res = await pm.submitToPane('', 'p', '/effort low', true, 'user', 'claude')
    check(res.ok, 'focus and cursor reports leave no draft')
    pm.write(ptyId, 'x', 'auto')
    res = await pm.submitToPane('', 'p', '/effort low', true, 'user', 'claude')
    check(!res.ok && res.error === 'busy', 'an automation that inserted without Enter leaves a draft too')
    pm.write(ptyId, '\r')
    st = { state: 'action', precise: true, provider: 'claude' }
    pm.write(ptyId, '1')
    st = { state: 'idle', precise: true, provider: 'claude' }
    res = await pm.submitToPane('', 'p', '/effort low', true, 'user', 'claude')
    check(res.ok, 'keys answering an open request (state action) leave no draft')
    st = { state: 'working', precise: true, provider: 'claude' }
    pm.write(ptyId, 'follow up')
    st = { state: 'action', precise: true, provider: 'claude' }
    pm.write(ptyId, '\r'); pm.write(ptyId, '\x03')
    st = { state: 'idle', precise: true, provider: 'claude' }
    writes.length = 0
    res = await pm.submitToPane('', 'p', '/effort high', true, 'user', 'claude')
    check(!res.ok && res.error === 'busy' && writes.length === 0, 'Enter or Ctrl+C answering a request keeps the follow-up typed before it')
    pm.write(ptyId, '\r')
    pm.write(ptyId, 'fix'); pm.write(ptyId, '\\');pm.write(ptyId, '\r')
    writes.length = 0
    res = await pm.submitToPane('', 'p', '/effort high', true, 'user', 'claude')
    check(!res.ok && res.error === 'busy' && writes.length === 0, 'backslash and Enter as two keystrokes add a line: the draft stays')
    pm.write(ptyId, '\x03')
    pm.write(ptyId, '\x1b')
    res = await pm.submitToPane('', 'p', '/effort high', true, 'user', 'claude')
    check(res.ok, 'a lone Esc leaves no draft')
    st = { state: 'idle', precise: true, provider: 'claude', ended: true }
    writes.length = 0
    res = await pm.submitToPane('', 'p', '/effort high', true, 'user', 'claude')
    check(!res.ok && res.error === 'busy' && writes.length === 0, 'an ended session (the pty is a shell again) refuses a gated Enter')
    for (const [label, s] of [['working', { state: 'working', precise: true, provider: 'claude' }], ['title-only', { state: 'idle', precise: false, provider: 'claude' }], ['other provider', { state: 'idle', precise: true, provider: 'codex' }], ['pending', { state: 'done', precise: true, provider: 'claude', pendingCount: 1 }], ['no status', null]]) {
      st = s; writes.length = 0
      res = await pm.submitToPane('', 'p', '/effort low', true, 'user', 'claude')
      check(!res.ok && res.error === 'busy' && writes.length === 0, `main refuses a gated Enter when ${label}`)
    }
    st = { state: 'idle', precise: true, provider: 'claude' }
    res = await pm.submitToPane('', 'p', 'echo', true)
    check(res.ok, 'an ungated submit is unchanged')
    pm.write(ptyId, 'draft')
    res = await pm.submitToPane('', 'p', 'echo', true)
    check(res.ok, 'an ungated submit ignores the draft (Quick Commands, schedules)')

    // 6b. userGate (typingBlocked on main's status): `snaos send` and Quick Commands.
    pm.write(ptyId, '\x03')
    for (const [label, s] of [['a precise action', { state: 'action', precise: true, provider: 'claude' }], ['an open request', { state: 'working', precise: true, provider: 'claude', pendingCount: 1 }]]) {
      st = s; writes.length = 0
      res = await pm.submitToPane('', 'p', 'yes', true, 'auto', undefined, true)
      check(!res.ok && res.error === 'awaiting_user' && writes.length === 0, `userGate: ${label} gets nothing, not even the text`)
    }
    st = { state: 'action', precise: false, provider: 'claude', pendingCount: 1 }; writes.length = 0
    res = await pm.submitToPane('', 'p', 'ok', true, 'auto', undefined, true)
    check(res.ok && writes.join('|') === 'ok|\r', 'userGate: a title-only action (end of turn) never blocks')
    // The menu opens while the text waits for its deferred Enter.
    st = { state: 'working', precise: true, provider: 'claude' }; writes.length = 0
    const submittedAt = pm.lastSubmitAt('p')
    let pending = pm.submitToPane('', 'p', 'run the tests', true, 'auto', undefined, true)
    st = { state: 'action', precise: true, provider: 'claude', pendingCount: 1 }
    res = await pending
    check(!res.ok && res.error === 'enter_held' && writes.join('|') === 'run the tests', 'userGate: a menu that opens before the Enter keeps the text typed and drops the Enter')
    check(pm.lastSubmitAt('p') === submittedAt, 'a dropped Enter is no submit (lastSubmitAt unchanged)')
    pm.write(ptyId, '\x03')
    st = { state: 'working', precise: true, provider: 'claude' }; writes.length = 0
    pending = pm.submitToPane('', 'p', 'second\n', false, 'auto', undefined, true)
    st = { state: 'working', precise: true, provider: 'claude', pendingCount: 1 }
    res = await pending
    check(!res.ok && res.error === 'enter_held' && writes.join('|') === 'second', 'userGate: a trailing line break (a typed Enter) is dropped the same way')
    pm.write(ptyId, '\x03')
    st = { state: 'working', precise: true, provider: 'claude' }; writes.length = 0
    res = await pm.submitToPane('', 'p', 'go on', true, 'auto', undefined, true)
    check(res.ok && writes.join('|') === 'go on|\r', 'userGate: a console still working at the Enter gets it')
    // Ungated callers (scheduler, composer, initial prompt) keep their Enter.
    writes.length = 0
    pending = pm.submitToPane('', 'p', 'tick', true, 'auto')
    st = { state: 'action', precise: true, provider: 'claude', pendingCount: 1 }
    res = await pending
    check(res.ok && writes.join('|') === 'tick|\r', 'without userGate the deferred Enter is unchanged (the scheduler has its own blocker)')
    pm.killAll()
  }

  // 7. Renderer executor.
  {
    const submits = [], hints = []
    let submitRes = { ok: true }
    const snApi = { pty: { killPanes: async () => 0, submit: async req => { submits.push(req); return submitRes } }, status: { tuneHint: h => hints.push(h) } }
    const R = loadRenderer(`export { useAppStore } from './store'; export { runAgentTune } from './agentTune'`, { window: { snApi }, document: { hasFocus: () => false } })
    const S = R.useAppStore
    S.setState({
      workspaces: [{ id: 'w', name: 'W', panes: [{ id: 'c', type: 'claude', title: 'C' }, { id: 'x', type: 'codex', title: 'X' }, { id: 's', type: 'shell', title: 'S' }], layout: {} }],
      presets: [],
      paneStatus: { c: { state: 'idle', precise: true, provider: 'claude' }, x: { state: 'idle', precise: true, provider: 'codex' } },
    })
    const tune = (paneId, set, enter, workspaceId = 'w') => R.runAgentTune({ kind: 'agentTune', workspaceId, paneId, set, enter })
    check((await tune('c', { kind: 'effort', value: 'high' }, false, 'other')).error === 'not_found' && (await tune('zz', { kind: 'picker' }, false)).error === 'not_found', 'a pane outside the workspace is not_found')
    check((await tune('s', { kind: 'picker' }, false)).error === 'not_agent', 'a shell is not an agent')
    check((await tune('x', { kind: 'model', value: 'opus' }, false)).error === 'unsupported' && submits.length === 0, 'Codex only takes the picker')
    let res = await tune('c', { kind: 'effort', value: 'high' }, false)
    check(res.ok && submits.length === 1 && JSON.stringify(submits[0]) === JSON.stringify({ ptyId: '', paneId: 'c', text: '/effort high', enter: false }) && hints.length === 0, 'Enter off types the command without Enter and leaves the read-back alone')
    res = await tune('c', { kind: 'ultracode', on: true }, true)
    check(res.ok && submits[1].enter === true && submits[1].readyFor === 'claude' && submits[1].text === '/effort ultracode on', 'Enter on asks main to gate it (readyFor)')
    check(JSON.stringify(hints) === '[{"paneId":"c","ultracode":true}]', 'an applied tune reaches main as a hint')
    res = await tune('x', { kind: 'picker' }, true)
    check(res.ok && submits[2].text === '/model' && submits[2].readyFor === 'codex' && hints.length === 1, 'Codex picker with Enter; no hint for the picker')
    S.setState(s => ({ paneStatus: { ...s.paneStatus, c: { state: 'working', precise: true, provider: 'claude' } } }))
    res = await tune('c', { kind: 'effort', value: 'low' }, true)
    check(res.error === 'busy' && submits.length === 3, 'a working agent answers busy without writing')
    S.setState(s => ({ paneStatus: { ...s.paneStatus, c: { state: 'idle', precise: true, provider: 'claude' } }, agentEnded: { c: { paneId: 'c', ptyId: 'pt', provider: 'claude', sessionId: 's', reason: 'other', at: 1 } } }))
    res = await tune('c', { kind: 'effort', value: 'low' }, true)
    check(res.error === 'busy' && submits.length === 3, 'an ended session (exit chip) answers busy without writing')
    S.setState({ agentEnded: {} })
    S.setState(s => ({ paneStatus: { ...s.paneStatus, c: { state: 'done', precise: true, provider: 'claude' } } }))
    submitRes = { ok: false, error: 'busy' }
    res = await tune('c', { kind: 'model', value: 'sonnet' }, true)
    check(res.error === 'busy' && hints.length === 1, "main's busy (a draft in the box) comes back as is, with no hint")
    submitRes = { ok: false, error: 'not_running' }
    check((await tune('c', { kind: 'model', value: 'sonnet' }, false)).error === 'not_running', 'not_running from main')
  }

  console.log(`PASS: ${checks} agent tune checks (commands, allowlist, Enter gate, unsent input, read-back hint, version gate, executor)`)
}

main().catch(err => { console.error(err); process.exit(1) })
