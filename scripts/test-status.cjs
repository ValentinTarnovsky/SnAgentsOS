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
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, Buffer, URL, fetch, Response, AbortController, setTimeout, clearTimeout, ...overrides })
  return mod.exports
}
const { notificationSettingsSchema, parseConfig, CONFIG_VERSION } = load('src/main/store/schema.ts')
// Renderer modules (store, persist, mounting) bundled together so they share one store instance.
function loadRenderer(contents, overrides = {}) {
  const code = buildSync({ stdin: { contents, resolveDir: path.join(root, 'src/renderer/lib'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, define: { 'process.env.NODE_ENV': '"production"' } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, crypto: globalThis.crypto, setTimeout, clearTimeout, ...overrides })
  return mod.exports
}
const { AGENT_ENV } = load('src/shared/brand.ts')
const settings = notificationSettingsSchema.parse({})
function harness() {
  const events = [], notices = [], timers = new Map()
  let seq = 0, focused = false
  const { StatusManager } = load('src/main/status/StatusManager.ts', {
    require: id => id === 'electron' ? { Notification: { isSupported: () => false } } : require(id),
    setTimeout: fn => { timers.set(++seq, fn); return seq }, clearTimeout: id => timers.delete(id),
  })
  const manager = new StatusManager(() => ({ isDestroyed: () => false, isFocused: () => focused, webContents: { send: (_ch, e) => events.push(e) }, flashFrame() {} }), () => null, n => notices.push(n))
  manager.setConfig(settings); manager.onSpawn('pty', 'pane')
  const event = (kind, rest = {}) => manager.onAgentEvent({ paneId: 'pane', ptyId: 'pty', provider: 'claude', sessionId: 'session', kind, ...rest })
  const hook = (name, rest = {}) => manager.onHookEvent({ consoleId: 'pane', ptyId: 'pty', sessionId: 'session', name, ...rest })
  const flush = () => { const fns = [...timers.values()]; timers.clear(); fns.forEach(fn => fn()) }
  return { manager, event, hook, events, notices, flush, focused: v => { focused = v }, last: () => events.at(-1) }
}

async function main() {
  {
    const h = harness(); h.hook('UserPromptSubmit')
    h.hook('PermissionRequest', { toolUseId: 'one' }); h.hook('PostToolUse', { toolUseId: 'one' })
    h.hook('PermissionRequest', { toolUseId: 'two' })
    check(h.events.filter(e => e.notify).length === 2, 'two distinct permissions within 15 seconds both notify')
    h.hook('PermissionRequest', { toolUseId: 'two' }); h.hook('Notification', { notificationType: 'permission_prompt' })
    check(h.notices.length === 2, 'exact and delayed duplicate requests do not notify twice')
    h.hook('PostToolUse', { toolUseId: 'two' }); h.hook('PermissionRequest', { toolUseId: 'two' })
    check(h.last().state === 'working', 'a resolved request replay does not resurrect attention')
  }
  {
    const h = harness(); h.manager.reportTitle('pane', '\u2802 Working'); h.manager.reportTitle('pane', '\u2733 First'); h.manager.reportTitle('pane', '\u2733 Changed')
    check(h.last().state === 'action', 'stopped title updates preserve pending attention')
    h.manager.reportTitle('pane', 'PowerShell'); h.hook('UserPromptSubmit'); h.hook('PermissionRequest', { toolUseId: 'one' }); h.flush()
    check(h.last().state === 'action', 'old title timer cannot clear precise hooks')
    h.manager.reportTitle('pane', '\u2802 Working'); h.manager.reportTitle('pane', 'PowerShell'); h.flush()
    check(h.last().state === 'action', 'titles cannot resolve precise pending requests')
  }
  {
    const h = harness(); h.event('start'); h.event('start', { sessionId: 'new' }); h.event('working', { sessionId: 'new' }); h.event('end')
    check(h.last().state === 'working', 'old SessionEnd cannot clear new session')
    h.event('request', { ptyId: 'old', requestId: 'stale' }); check(h.last().state === 'working', 'old PTY events are ignored')
    h.manager.onExit('old', 'pane'); check(h.manager.snapshot().length === 1, 'old PTY exit cannot clear new track')
    h.event('end', { sessionId: 'new' }); h.event('request', { sessionId: 'new', requestId: 'late' }); check(h.last().state === 'idle', 'ended session rejects late events')
    h.event('start', { sessionId: 'new' }); h.event('working', { sessionId: 'new' }); check(h.last().state === 'working', 'same session can resume explicitly')
  }
  {
    const h = harness(); h.event('start', { provider: 'codex' })
    h.event('request', { provider: 'codex', requestId: 'a', reason: 'question' }); h.event('request', { provider: 'codex', requestId: 'b', reason: 'permission' })
    h.event('working', { provider: 'codex' }); check(h.last().pendingCount === 2 && h.last().state === 'action', 'working does not clear async questions')
    h.event('resolved', { provider: 'codex', requestId: 'a' }); check(h.last().pendingCount === 1, 'resolve only the matching request')
    h.event('done', { provider: 'codex' }); check(h.last().state === 'action', 'done preserves outstanding async question')
    h.event('resolved', { provider: 'codex', requestId: 'b' }); check(h.last().state === 'done', 'last answer reveals completed state')
    check(h.manager.snapshot()[0].notify === false, 'snapshot never replays notification sounds')
    h.event('unknown', { provider: 'codex' }); check(h.last().state === 'unknown', 'disconnect never claims success')
    h.event('start', { provider: 'codex' }); check(h.last().state === 'idle', 'reconnected idle session clears lost connection')
    h.event('start', { provider: 'codex', sessionId: 'other' }); h.event('start', { provider: 'codex' })
    h.event('working', { provider: 'codex' }); check(h.last().state === 'working', 'Codex can explicitly resume a previously visited thread')
  }
  {
    const h = harness(); h.hook('UserPromptSubmit'); h.hook('PreToolUse', { toolName: 'AskUserQuestion', toolUseId: 'q' }); check(h.last().state === 'action', 'Claude question detected directly')
    h.hook('PostToolUse', { toolUseId: 'q' }); check(h.last().state === 'working', 'Claude question response resumes work')
    h.hook('Stop'); h.hook('PreToolUse', { toolName: 'Bash' }); h.flush(); check(h.last().state === 'working', 'continued stop hook cannot mark done')
    h.hook('Stop'); h.flush(); check(h.last().state === 'done', 'settled Stop marks done')
    h.hook('StopFailure'); check(h.last().state === 'error', 'terminal failure is explicit')
    h.hook('UserPromptSubmit'); h.hook('Stop', { agentId: 'child' }); h.flush(); check(h.last().state === 'working', 'child stop cannot finish main agent')
    h.hook('PermissionRequest', { agentId: 'child', toolUseId: 'child-request' }); check(h.last().state === 'action', 'child approval still reaches user')
  }
  {
    const h = harness(); h.manager.setViewed(['pane']); h.focused(true); h.hook('PermissionRequest', { toolUseId: 'a' })
    check(h.last().notify === false && h.notices.length === 1, 'Discord routing independent of desktop focus')
    h.manager.setConfig({ ...settings, enabled: false }); h.hook('PermissionRequest', { toolUseId: 'b' })
    check(h.last().notify === false && h.notices.length === 2, 'Discord routing independent of desktop master switch')
    h.manager.testDesktop(); check(h.manager.desktopError === 'unavailable', 'unsupported desktop delivery is visible in health')
  }
  {
    let failure = 'Notification failed. HRESULT:-2143420140'
    class NativeNotification extends require('events').EventEmitter {
      static isSupported() { return true }
      show() { this.emit('failed', {}, failure) }
    }
    const { StatusManager } = load('src/main/status/StatusManager.ts', { require: id => id === 'electron' ? { Notification: NativeNotification } : require(id), console: { ...console, warn() {} } })
    const manager = new StatusManager(() => null, () => null)
    manager.testDesktop(); check(manager.desktopError === 'blocked', 'Windows disabled notifications are reported explicitly')
    failure = 'other native failure'; manager.testDesktop(); check(manager.desktopError === 'failed', 'other native errors are not reported as success')
  }
  // E4-FR-07: delivery inApp / native / none, and no OS toast or flash for inApp.
  {
    let shown = 0, flashes = 0, focused = true
    class NativeNotification extends require('events').EventEmitter {
      static isSupported() { return true }
      show() { shown++ }
    }
    const { StatusManager } = load('src/main/status/StatusManager.ts', { require: id => id === 'electron' ? { Notification: NativeNotification } : require(id) })
    const events = []
    const win = { isDestroyed: () => false, isFocused: () => focused, webContents: { send: (_ch, e) => events.push(e) }, flashFrame: () => { flashes++ } }
    const manager = new StatusManager(() => win, () => null)
    manager.setConfig(settings); manager.onSpawn('pty', 'pane')
    const hook = (name, rest = {}) => manager.onHookEvent({ consoleId: 'pane', ptyId: 'pty', sessionId: 'session', name, ...rest })
    const notice = () => events.filter(e => e.delivery).at(-1)
    hook('PermissionRequest', { toolUseId: 'a' })
    check(notice().delivery === 'inApp' && notice().notify === true && shown === 0 && flashes === 0, 'focused + out of view: inApp, no OS notification and no taskbar flash')
    focused = false; hook('PermissionRequest', { toolUseId: 'b' })
    check(notice().delivery === 'native' && shown === 1 && flashes === 1, 'unfocused: native notification (and flash) as before')
    focused = true; manager.setViewed(['pane']); hook('PermissionRequest', { toolUseId: 'c' })
    check(notice().delivery === 'none' && notice().notify === false && shown === 1, 'focused and in view: none')
    manager.setViewed([]); manager.setConfig({ ...settings, inAppWhenFocused: false }); hook('PermissionRequest', { toolUseId: 'd' })
    check(notice().delivery === 'native' && shown === 2 && flashes === 1, 'inAppWhenFocused=false brings back the native notification (no flash while focused)')
    manager.setConfig({ ...settings, enabled: false }); hook('PermissionRequest', { toolUseId: 'e' })
    check(notice().delivery === 'none' && shown === 2, 'notifications off: none')
    hook('PostToolUse', { toolUseId: 'e' })
    check(events.at(-1).delivery === undefined && events.at(-1).state === 'action', 'non-notice status events carry no delivery')
  }
  const { CodexProtocol } = load('src/main/status/CodexProtocol.ts')
  {
    const events = [], a = new CodexProtocol('a', 'pty-a', e => events.push(e)), b = new CodexProtocol('b', 'pty-b', e => events.push(e))
    const send = (p, side, m) => p[side](JSON.stringify(m))
    for (const [p, id] of [[a, 'thread-a'], [b, 'thread-b']]) { send(p, 'client', { id: 1, method: 'thread/start' }); send(p, 'server', { id: 1, result: { thread: { id, status: { type: 'idle' } } } }) }
    check(events[0].paneId === 'a' && events[1].paneId === 'b', 'protocol attributes identical request IDs on separate connections')
    send(a, 'server', { id: 99, method: 'item/tool/requestUserInput', params: { threadId: 'thread-a', isBlocking: false } })
    check(events.at(-1).kind === 'request' && events.at(-1).reason === 'question', 'nonblocking RPC question captured')
    send(a, 'server', { method: 'serverRequest/resolved', params: { threadId: 'thread-a', requestId: 99 } })
    check(events.at(-1).kind === 'resolved', 'RPC resolution captured')
    send(a, 'server', { method: 'item/completed', params: { threadId: 'thread-a', item: { type: 'agentMessage', id: 'async-q', delivery: 'async', questions: [{ title: 'q' }] } } })
    check(events.at(-1).requestId === 'async:async-q', 'async agent message questions captured')
    send(a, 'client', { id: 3, method: 'turn/steer', params: { threadId: 'thread-a', input: [{ type: 'text', text: 'reply' }] } })
    send(a, 'server', { id: 3, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-a' } })
    check(events.at(-1).kind === 'request', 'server request sharing a client ID does not acknowledge user input')
    send(a, 'server', { id: 3, error: { code: -1 } }); check(events.at(-1).kind === 'request', 'failed user submission does not acknowledge question')
    send(a, 'client', { id: 4, method: 'turn/steer', params: { threadId: 'thread-a', input: [{ type: 'text', text: 'reply' }] } })
    send(a, 'server', { id: 4, result: {} }); check(events.at(-1).kind === 'resolved', 'accepted user reply acknowledges async message questions')
    const n = events.length; send(a, 'server', { method: 'turn/completed', params: { threadId: 'child', turn: { status: 'completed' } } }); check(events.length === n, 'unrelated turn cannot complete foreground session')
    send(a, 'server', { method: 'turn/started', params: { threadId: 'thread-a', turn: { id: 'turn' } } })
    send(a, 'server', { method: 'turn/completed', params: { threadId: 'thread-a', turn: { id: 'old-turn', status: 'completed' } } })
    check(events.at(-1).kind === 'working', 'late completion cannot stop the current turn')
    send(a, 'server', { method: 'turn/completed', params: { threadId: 'thread-a', turn: { status: 'failed', id: 'turn' } } }); check(events.at(-1).kind === 'error', 'Codex terminal failure captured')
    a.disconnected(); check(events.at(-1).kind === 'unknown', 'transport loss reported')
  }
  const { visiblePaneIds, aggregateStatus } = load('src/shared/status.ts')
  check(visiblePaneIds({ panes: [{ id: 'a' }, { id: 'b' }] }, [], 'a').join() === 'a', 'maximization excludes hidden consoles')
  check(visiblePaneIds({ panes: [{ id: 'a' }, { id: 'b' }] }, ['b']).join() === 'a', 'minimization excludes hidden consoles')
  check(aggregateStatus([{ state: 'working' }, { state: 'action' }]).state === 'action', 'sidebar prioritizes pending action')
  check(aggregateStatus([{ state: 'done' }, { state: 'unknown' }]).state === 'unknown', 'sidebar cannot hide lost connection behind success')

  const { DiscordNotifier, discordUrl, discordPayload } = load('src/main/status/DiscordNotifier.ts')
  const discord = { ...settings.discord, enabled: true, webhookUrl: 'https://discord.com/api/webhooks/123456789012345678/fake-token', userId: '123456789012345679' }
  check(discordUrl(discord.webhookUrl).endsWith('?wait=true'), 'Discord confirms delivery')
  for (const url of ['http://discord.com/api/webhooks/123456789012345678/token', 'https://evil.test/api/webhooks/123456789012345678/token', 'https://discord.com@evil.test/api/webhooks/123456789012345678/token', 'https://discord.com/api/webhooks/1/token', 'https://discord.com:444/api/webhooks/123456789012345678/token']) {
    assert.throws(() => discordUrl(url)); checks++
  }
  check(discordPayload(discord, '@everyone').allowed_mentions.parse.length === 0, 'mentions limited to configured user')
  {
    let attempts = 0, delay = 0
    const notifier = new DiscordNotifier(async (_url, init) => { check(JSON.parse(init.body).allowed_mentions.users[0] === discord.userId, 'correct user mention'); return ++attempts === 1 ? new Response(JSON.stringify({ retry_after: 0.01 }), { status: 429 }) : new Response('{}', { status: 200 }) }, async ms => { delay = ms })
    check((await notifier.test(discord)).ok && attempts === 2 && delay >= 100, 'rate limit retry preserves notification')
    check(notifier.health.lastSuccessAt !== null && !notifier.health.error, 'delivery health recorded')
  }
  {
    let attempts = 0
    const notifier = new DiscordNotifier(async () => { attempts++; return new Response('{}', { status: 400 }) })
    check(!(await notifier.test(discord)).ok && attempts === 1, 'permanent failure is not retried')
    check(!notifier.health.error.includes('fake-token'), 'errors never expose webhook token')
  }
  {
    let attempts = 0
    const notifier = new DiscordNotifier(async () => { attempts++; throw new Error(discord.webhookUrl) })
    check(!(await notifier.test(discord)).ok && attempts === 1, 'ambiguous delivery is not blindly duplicated')
    check(!notifier.health.error.includes('fake-token'), 'transport errors are sanitized')
  }
  {
    let attempts = 0
    const notifier = new DiscordNotifier(async () => { attempts++; return new Response('{}', { status: attempts < 3 ? 503 : 200 }) }, async () => {})
    check((await notifier.test(discord)).ok && attempts === 3, 'transient HTTP failures retry with bound')
  }
  check(settings.discord.enabled === false && settings.codexEnabled === false, 'old config has safe integration defaults')
  check(notificationSettingsSchema.parse({ discord: { enabled: true } }).discord.notifyAction, 'partial Discord settings migrate field defaults')

  for (const [args, remote] of [[[], true], [['resume'], true], [['resume', '--no-daemon'], false], [['-c', 'x=1', 'exec', 'task'], false], [['--model', 'exec', 'task'], true], [['--remote=ws://localhost:1'], false], [['--version'], false]]) {
    let launched
    class LaunchSocket extends require('events').EventEmitter {
      constructor() { super(); process.nextTick(() => this.emit('open')) }
      send(raw) { check(JSON.parse(raw).cwd === process.cwd(), 'launcher forwards actual shell directory'); process.nextTick(() => this.emit('message', Buffer.from('{"ok":true}'))) }
      close() { this.emit('close') }
    }
    load('src/main/status/statusRuntime.ts', {
      process: { ...process, argv: ['node', 'runtime', ...args], env: { [AGENT_ENV.realCodex]: 'codex', [AGENT_ENV.codexUrl]: 'ws://127.0.0.1:1' } },
      require: id => id === 'ws' ? { WebSocket: LaunchSocket } : id === 'child_process' ? { spawn: (_exe, actual) => { launched = actual; return new (require('events').EventEmitter)() } } : require(id),
    })
    await new Promise(resolve => setImmediate(resolve))
    check((launched[0] === '--remote') === remote, 'launcher preserves command arguments: ' + args.join(' '))
  }

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-hooks-test-'))
  const { CodexBridge } = load('src/main/status/CodexBridge.ts')
  const bridge = new CodexBridge(() => path.join(temporary, 'launcher'), 'test-runtime.js', () => {})
  bridge.findExecutable = () => process.execPath
  try {
    await bridge.configure(true)
    const env = bridge.environment('test-pty', 'test-pane', temporary)
    const WebSocket = require('ws')
    for (const headers of [{}, { Authorization: 'Bearer incorrect' }, { Authorization: 'Bearer ' + env[AGENT_ENV.codexToken], Origin: 'https://example.test' }]) {
      const rejected = await new Promise(resolve => { const socket = new WebSocket(env[AGENT_ENV.codexUrl], { headers }); socket.once('error', () => resolve(true)); socket.once('open', () => { socket.close(); resolve(false) }) })
      check(rejected, 'Codex bridge rejects missing/wrong token and browser origins')
    }
    const accepted = await new Promise((resolve, reject) => {
      const socket = new WebSocket(env[AGENT_ENV.codexUrl], { headers: { Authorization: 'Launch ' + env[AGENT_ENV.codexToken] } })
      socket.once('error', reject); socket.once('open', () => socket.send(JSON.stringify({ cwd: temporary, env: { TEST_CONTEXT: 'preserved' } })))
      socket.once('message', raw => { resolve(JSON.parse(raw.toString()).ok); socket.close() })
    })
    check(accepted, 'authenticated launch context accepted without starting a model')
  } finally { bridge.dispose() }
  const { HookServer } = load('src/main/status/HookServer.ts')
  const server = new HookServer(), received = []
  server.onEvent(e => received.push(e))
  try {
    const installer = load('src/main/status/HookInstaller.ts', { process: { ...process, env: { ...process.env, CLAUDE_CONFIG_DIR: temporary } } })
    const file = path.join(temporary, 'settings.json'), token = 'a'.repeat(32)
    const port = await server.start(0, token)
    fs.writeFileSync(file, '\ufeff' + JSON.stringify({ custom: 'español', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-command' }] }] } }), 'utf8')
    installer.installHooks(port, token)
    check(installer.hooksStatus().complete, 'all installed handlers are verified')
    let data = JSON.parse(fs.readFileSync(file, 'utf8'))
    check(data.custom === 'español' && data.hooks.Stop[0].hooks[0].command === 'user-command', 'UTF-8 and user hooks preserved')
    check(data.hooks.SessionStart[0].hooks[0].type === 'command', 'SessionStart uses compatible command transport')
    const body = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'session-\u00f1' })
    const command = data.hooks.SessionStart[0].hooks[0].command
    await new Promise((resolve, reject) => {
      const child = require('child_process').spawn(process.platform === 'win32' ? 'powershell.exe' : '/bin/sh', process.platform === 'win32' ? command.split(' ').slice(1) : ['-c', command], { env: { ...process.env, [AGENT_ENV.consoleId]: 'pane', [AGENT_ENV.ptyId]: 'pty' }, windowsHide: true, timeout: 10000 })
      child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error('SessionStart relay exit ' + code)))
      child.stdin.end(body)
    })
    check(received.length === 1 && received[0].sessionId === 'session-\u00f1' && received[0].ptyId === 'pty', 'real SessionStart command relays UTF-8 and PTY identity')
    const endpoint = `http://127.0.0.1:${port}/cc-hook/${token}`
    const response = await fetch(endpoint, { method: 'POST', headers: { 'X-Console-Id': 'pane', 'X-Pty-Id': 'pty' }, body: JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'session', tool_use_id: 'tool-id', tool_name: 'Bash' }) })
    check(response.status === 200 && await response.text() === '' && received.at(-1).toolUseId === 'tool-id', 'HTTP observer forwards request identity without returning a decision')
    check((await fetch(endpoint + 'wrong', { method: 'POST', body })).status === 404 && received.length === 2, 'wrong hook token rejected')
    await fetch(endpoint, { method: 'POST', body }); check(received.length === 2, 'hooks outside the app ignored')
    data.hooks.PermissionRequest = []; fs.writeFileSync(file, JSON.stringify(data))
    check(!installer.hooksUpToDate(port, token), 'partial installation detected')
    installer.installHooks(port, token); installer.uninstallHooks()
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
    check(data.hooks.Stop[0].hooks[0].command === 'user-command' && data.custom === 'español', 'uninstall preserves unrelated settings')
    fs.writeFileSync(file, '{broken')
    assert.throws(() => installer.installHooks(port, token)); checks++
    check(fs.readFileSync(file, 'utf8') === '{broken', 'corrupt settings never overwritten')
  } finally { await server.stop(); fs.rmSync(temporary, { recursive: true, force: true }) }
  await schemaV11Checks()
  await enrichmentChecks()
  console.log(`PASS: ${checks} status, protocol, visibility, Discord, installer, schema 11, store and enrichment checks`)
}

// R21-01: schema 11 (defaults only, no migrate() logic), the config upgrade
// write, the mounting primitive (D4) and the reference-gated persistence writer.
async function schemaV11Checks() {
  const v10 = {
    version: 10,
    workspaces: [{ id: 'w1', name: 'Uno', cwd: 'C:/repo', favorite: true, setupId: 'c1', layout: { grid: 2, order: ['p1', 'p2'] }, panes: [
      { id: 'p1', type: 'claude', presetId: 'preset-claude', title: 'Claude', color: '#d97757', icon: 'claude', fontSize: 15, schedule: { time: '09:30', prompt: 'hola', dueAt: 1 } },
      { id: 'p2', type: 'shell', title: 'Shell \u00f1', color: '#fff', icon: 'terminal' },
    ] }, { id: 'w2', name: 'Dos', cwd: '', panes: [{ id: 'p3', type: 'codex', title: 'Codex', color: '#10a37f', icon: 'openai' }] }],
    presets: [{ id: 'preset-claude', name: 'Claude Code', type: 'claude', command: 'claude', args: ['--verbose'], color: '#d97757', icon: 'claude', env: { A: '1' } }],
    settings: { defaultShell: { win32: 'pwsh.exe' }, fontFamily: 'mono', fontSize: 14, accent: 'blue', theme: 'nord', language: 'es', scrollback: 1000, infiniteScrollback: false, terminalRenderer: 'webgl', terminalSelectionOverride: false, restoreLastWorkspace: true, confirmCloseRunning: false, closeToTray: false, launchOnStartup: true, autoCheckUpdates: false, globalHotkeyEnabled: true, globalHotkey: 'Super+Alt+P', keymap: { palette: 'Ctrl+P' }, sidebarCollapsed: true, usage: { enabled: false }, remote: { enabled: true, port: 4518 }, notifications: { enabled: false, hooksEnabled: true, hookToken: 'a'.repeat(32), discord: { enabled: true, webhookUrl: 'x' } } },
    activeWorkspaceId: 'w2',
    snippets: [{ id: 's1', name: 'S', text: 'texto' }],
    connections: [{ id: 'c1', name: 'SSH', steps: [{ send: 'ssh host', waitFor: 'password:', secret: false }] }],
    keyButtons: [{ id: 'k1', label: 'Esc', seq: '\u001b' }],
  }
  check(CONFIG_VERSION === 11, 'CONFIG_VERSION is 11')
  const c = parseConfig(JSON.parse(JSON.stringify(v10)))
  check(c && c.version === 11, 'a v10 config parses and is stamped 11')
  const st = c.settings
  check(st.awakeMode === 'auto' && st.terminalUnicode11 === true && st.terminalAgentEndChip === true && st.notifications.inAppWhenFocused === true, 'v10 gains awakeMode, terminalUnicode11, terminalAgentEndChip and inAppWhenFocused defaults')
  check(JSON.stringify(st.agents) === JSON.stringify({ resumeOnStartup: 'ask', awakeDisplay: false, sidebarAgentRows: true, topicAsTitle: true, ctrlDigitFocus: true }), 'v10 gains the settings.agents defaults')
  check(c.workspaces.every(w => w.agentsCollapsed === undefined && w.panes.every(p => p.lastSession === undefined)), 'agentsCollapsed and lastSession stay absent')
  const same = (a, b) => { if (a === b) return true; if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false; return Object.keys(a).every(k => k === 'version' || same(a[k], b[k])) }
  check(same(v10, c), 'every v10 value survives the parse unchanged')
  check(st.terminalRenderer === 'webgl' && st.keymap.palette === 'Ctrl+P' && c.workspaces[0].panes[0].schedule.prompt === 'hola', 'opt-in renderer, keymap and schedules are kept')
  const v11 = JSON.parse(JSON.stringify(v10)); v11.version = 11
  v11.settings.terminalRenderer = 'dom'; v11.settings.awakeMode = 'sometimes'; v11.settings.terminalUnicode11 = 'yes'
  v11.settings.agents = { resumeOnStartup: 'auto', ctrlDigitFocus: false }
  v11.workspaces[0].agentsCollapsed = true
  v11.workspaces[0].panes[0].lastSession = { provider: 'claude', sessionId: '0123abcd-0000-4000-8000-000000000000', cwd: 'C:/repo', at: 5 }
  v11.workspaces[0].panes[1].lastSession = { provider: 'gemini', sessionId: '', cwd: 1 }
  v11.workspaces[1].agentsCollapsed = 'no'
  v11.workspaces[1].panes[0].lastSession = { provider: 'codex', sessionId: 'abcd1234; calc.exe', cwd: 'C:/repo', at: 6 }
  const d = parseConfig(v11)
  check(d && d.settings.terminalRenderer === 'canvas' && d.settings.awakeMode === 'auto' && d.settings.terminalUnicode11 === true, 'junk renderer, awake mode and Unicode values fall back without rejecting the config')
  check(d.settings.agents.resumeOnStartup === 'auto' && d.settings.agents.ctrlDigitFocus === false && d.settings.agents.topicAsTitle === true, 'partial agents settings keep values and default the rest')
  check(d.workspaces[0].agentsCollapsed === true && d.workspaces[1].agentsCollapsed === undefined, 'agentsCollapsed kept, malformed value dropped')
  check(d.workspaces[0].panes[0].lastSession.sessionId.startsWith('0123abcd') && d.workspaces[0].panes[1].lastSession === undefined, 'valid lastSession kept, malformed one dropped instead of failing the whole config')
  check(d.workspaces[1].panes[0].lastSession === undefined, 'a lastSession id with shell syntax (imported config) is dropped')
  check(parseConfig({ ...v10, version: 12 }).version === 11, 'parse stamps the current version')

  // ConfigStore: only the renderer load (upgrade) stamps an older file, once.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-config-test-'))
  try {
    const app = { getPath: () => dir, isPackaged: false }
    const { ConfigStore } = load('src/main/store/ConfigStore.ts', { require: id => (id === 'electron' ? { app } : require(id)), process: { ...process, env: {}, argv: ['electron'] }, console: { ...console, warn() {} } })
    const file = path.join(dir, 'config.json'), raw = JSON.stringify(v10)
    fs.writeFileSync(file, raw)
    const store = new ConfigStore()
    check(store.load().version === 11 && fs.readFileSync(file, 'utf8') === raw, 'a plain load stays read-only (legacy verification safe)')
    check(store.load({ upgrade: true }).version === 11 && JSON.parse(fs.readFileSync(file, 'utf8')).version === 11, 'the renderer load leaves config.json on v11')
    check(fs.readFileSync(file + '.bak', 'utf8') === raw && fs.readdirSync(path.join(dir, 'backups')).length === 1, 'the pre-upgrade v10 file is kept as .bak and in backups/')
    const once = fs.readFileSync(file, 'utf8'); fs.writeFileSync(file + '.bak', 'marker')
    store.load({ upgrade: true })
    check(fs.readFileSync(file + '.bak', 'utf8') === 'marker' && fs.readFileSync(file, 'utf8') === once, 'an already current file is not rewritten')
    const newer = JSON.stringify({ ...v10, version: 12 }); fs.writeFileSync(file, newer)
    store.load({ upgrade: true })
    check(fs.readFileSync(file, 'utf8') === newer, 'a newer file (downgrade) is never rewritten')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }

  // Mounting primitive (D4).
  const m = loadRenderer(`export * from './mounting'`)
  const full = m.withMounted({}, 'w1', ['p1'])
  check(full.w1 === 'full', 'ensureMounted without only mounts full')
  check(m.withMounted(full, 'w1', ['p1'], { only: ['p1'] }) === full && m.withMounted(full, 'w1', ['p1']) === full, 'a full workspace never narrows, same reference')
  const part = m.withMounted({}, 'w2', ['a', 'b', 'c'], { only: ['b', 'zz', 'b'] })
  check(JSON.stringify(part.w2) === '["b"]', 'only mounts the listed known panes, deduplicated')
  const more = m.withMounted(part, 'w2', ['a', 'b', 'c'], { only: ['b', 'c'] })
  check(JSON.stringify(more.w2) === '["b","c"]' && JSON.stringify(part.w2) === '["b"]' && m.withMounted(more, 'w2', ['a', 'b', 'c'], { only: ['c'] }) === more, 'only adds to the list immutably, no-op when already there')
  check(m.withMounted(more, 'w2', ['a', 'b', 'c']).w2 === 'full', 'activation upgrades a partial mount to full')
  check(m.isPaneMounted(more, 'w2', 'c') && !m.isPaneMounted(more, 'w2', 'a') && m.isPaneMounted(full, 'w1', 'any') && !m.isPaneMounted({}, 'w1', 'p1'), 'pane mount state')
  check(m.isWorkspaceMounted(more, 'w2') && !m.isWorkspaceMounted(more, 'w9') && m.withoutMounted(more, 'w9') === more && !('w2' in m.withoutMounted(more, 'w2')), 'workspace mount state and unmount on delete')

  // Store + persistence: transient state never writes config.json.
  const saves = [], timers = new Map()
  let seq = 0
  const flush = () => { const fns = [...timers.values()]; timers.clear(); fns.forEach(fn => fn()) }
  const r = loadRenderer(`export { startPersistence } from './persist'; export { useAppStore } from './store'`, {
    window: { snApi: { config: { save: cfg => saves.push(JSON.parse(JSON.stringify(cfg))) } } },
    document: { hasFocus: () => false },
    setTimeout: fn => { timers.set(++seq, fn); return seq }, clearTimeout: id => timers.delete(id),
  })
  const S = r.useAppStore
  S.getState().hydrate(c)
  check(S.getState().activeWorkspaceId === 'w2' && JSON.stringify(S.getState().mountedWorkspaces) === '{"w2":"full"}', 'hydrate mounts only the restored workspace')
  check(S.getState().settings.agents.resumeOnStartup === 'ask' && S.getState().settings.notifications.inAppWhenFocused === true, 'hydrated store carries the v11 settings')
  const stop = r.startPersistence()
  S.getState().setPaneStatus({ paneId: 'p1', state: 'working', precise: true, notify: false, provider: 'claude', updatedAt: 1 })
  S.getState().setPaneStatus({ paneId: 'p1', state: 'done', precise: true, notify: true, provider: 'claude', updatedAt: 2 })
  check(S.getState().paneStatus.p1.state === 'done' && S.getState().paneAttention.p1 === true, 'status change applied and flagged attention')
  S.getState().ensureMounted('w1', { only: ['p2'] })
  check(JSON.stringify(S.getState().mountedWorkspaces.w1) === '["p2"]' && S.getState().activeWorkspaceId === 'w2', 'ensureMounted only mounts without activating')
  S.getState().restartPane('p1'); S.getState().setPaletteOpen(true); S.getState().ensureMounted('nope')
  check(timers.size === 0 && saves.length === 0, 'paneStatus, attention, mount, epoch and palette changes do not persist')
  S.getState().setActive('w1')
  check(S.getState().mountedWorkspaces.w1 === 'full', 'activating a partially mounted workspace mounts it full')
  flush()
  check(saves.length === 1 && saves[0].version === 11 && saves[0].activeWorkspaceId === 'w1', 'a persisted slice change writes once, stamped 11')
  S.getState().renamePane('w1', 'p1', 'Renombrada'); S.getState().updateSettings({ awakeMode: 'always' }); flush()
  check(saves.length === 2 && saves[1].workspaces[0].panes[0].title === 'Renombrada' && saves[1].settings.awakeMode === 'always', 'debounced writes carry the latest state')
  check(!('mountedWorkspaces' in saves[1]) && !('paneStatus' in saves[1]) && saves[1].settings.agents.ctrlDigitFocus === true, 'transient slices never reach config.json, v11 settings do')
  S.getState().deleteWorkspace('w1')
  check(!('w1' in S.getState().mountedWorkspaces) && S.getState().mountedWorkspaces.w2 === 'full', 'deleting a workspace unmounts it and mounts the next active one')
  check(m.keepMounted({ a: 'full', b: ['p'], c: 'full' }, ['b', 'c', 'z']).a === undefined && JSON.stringify(m.keepMounted({ a: 'full', b: ['p'] }, ['b'])) === '{"b":["p"]}', 'keepMounted keeps only surviving workspace ids')
  S.getState().importConfig({ ...c, workspaces: [{ ...c.workspaces[0], id: 'w3' }, c.workspaces[1]] })
  check(JSON.stringify(S.getState().mountedWorkspaces) === '{"w2":"full","w3":"full"}' && S.getState().activeWorkspaceId === 'w3', 'replace import keeps a surviving workspace mounted (its consoles keep running) and mounts the new active one')
  stop()
}

// R21-02: status enrichment (E4-FR-09, E5-FR-01/02, E1-FR-01/09, E6-FR-21 parsing).
async function enrichmentChecks() {
  const SID = '0123abcd-0000-4000-8000-000000000000'
  function rich({ config = null, reader, start = 1000 } = {}) {
    const events = [], causes = [], timers = new Map()
    let seq = 0, clock = start
    class FakeDate extends Date { static now() { return clock } }
    const { StatusManager } = load('src/main/status/StatusManager.ts', {
      require: id => id === 'electron' ? { Notification: { isSupported: () => false } } : require(id),
      setTimeout: fn => { timers.set(++seq, fn); return seq }, clearTimeout: id => timers.delete(id), Date: FakeDate,
    })
    const manager = new StatusManager(() => ({ isDestroyed: () => false, isFocused: () => false, webContents: { send: (_ch, e) => events.push(e) }, flashFrame() {} }), () => config, () => {}, reader)
    manager.setConfig(settings); manager.onSpawn('pty', 'pane')
    const heard = []
    const off = manager.addListener((e, cause) => { heard.push(e); causes.push(cause) })
    const hook = (name, rest = {}) => manager.onHookEvent({ consoleId: 'pane', ptyId: 'pty', sessionId: SID, name, ...rest })
    const flush = () => { while (timers.size) { const fns = [...timers.values()]; timers.clear(); fns.forEach(fn => fn()) } }
    return { manager, hook, events, heard, causes, off, flush, tick: ms => { clock += ms }, last: () => events.at(-1) }
  }

  // stateSince (E4-FR-09 c, E5-FR-02).
  {
    const h = rich()
    h.hook('SessionStart'); h.tick(10); h.hook('UserPromptSubmit', { prompt: 'arregl\u00e1 el login\nm\u00e1s texto' })
    const since = h.last().stateSince
    check(h.last().state === 'working' && since === 1010, 'stateSince marks the transition to working')
    h.tick(600); h.hook('PreToolUse', { toolName: 'Read', toolSummary: 'Read a.ts' }); h.flush()
    h.tick(600); h.hook('PreToolUse', { toolName: 'Bash', toolSummary: 'Bash: ls' }); h.flush()
    check(h.last().state === 'working' && h.last().stateSince === since && h.last().updatedAt > since, 'two working events keep stateSince while updatedAt moves')
    check(h.last().firstPrompt === 'arregl\u00e1 el login', 'firstPrompt is the first line of the first prompt')
    h.tick(100); h.hook('UserPromptSubmit', { prompt: 'otro pedido' }); h.flush()
    check(h.last().firstPrompt === 'arregl\u00e1 el login' && h.last().detail.kind === 'prompt' && h.last().detail.text === 'otro pedido', 'later prompts change the detail, not firstPrompt')
    h.tick(100); h.hook('Stop', { lastAssistantMessage: 'Listo.' }); h.flush()
    check(h.last().state === 'done' && h.last().stateSince === 1000 + 10 + 600 + 600 + 100 + 100 && h.last().cacheSince === h.last().stateSince, 'working -> done moves stateSince and starts cacheSince')
    check(h.manager.snapshot()[0].stateSince === h.last().stateSince && h.manager.stateOf('pane').stateSince === h.last().stateSince && h.manager.stateOf('nope') === null, 'snapshot and stateOf carry stateSince (survives a renderer reload)')
    h.tick(50); h.hook('SessionStart')
    check(h.last().firstPrompt === undefined && h.last().lastMessage === undefined && h.last().detail === undefined, 'a new start resets firstPrompt, reply and detail')
    h.tick(50); h.hook('UserPromptSubmit', { prompt: 'nuevo' })
    check(h.last().firstPrompt === 'nuevo' && h.last().cacheSince === undefined, 'firstPrompt set again after start; working clears cacheSince')
  }
  // Clips and pending (E4-FR-09 AC).
  {
    const h = rich()
    h.hook('UserPromptSubmit', { prompt: 'x' })
    h.hook('Stop', { lastAssistantMessage: 'a'.repeat(1000) }); h.flush()
    check(h.last().lastMessage.length <= 280 && h.last().lastMessage.endsWith('\u2026'), 'a 1000-char reply becomes a lastMessage of at most 280')
    h.hook('UserPromptSubmit', { prompt: 'y' })
    h.hook('PreToolUse', { toolName: 'AskUserQuestion', toolUseId: 'q1', question: 'Cual?', questions: [{ question: 'Cual?', header: 'Elegir', multiSelect: false, options: [{ label: 'A', description: 'la a' }, { label: 'B' }] }] })
    const q = h.last()
    check(q.state === 'action' && q.pending[0].kind === 'question' && q.pending[0].id === 'q1' && q.pending[0].questions[0].options.length === 2 && q.detail.kind === 'question', 'AskUserQuestion leaves pending[0] as a question with its questions')
    h.hook('PostToolUse', { toolUseId: 'q1' })
    check(h.last().pending === undefined && h.last().pendingCount === 0, 'a resolved request leaves pending[] in the same event')
    const long = 'Bash: ' + 'echo ' + 'z'.repeat(400)
    h.hook('PermissionRequest', { toolUseId: 'p1', toolName: 'Bash', toolSummary: long.slice(0, 160), requestSummary: long.slice(0, 200) })
    const p = h.last()
    check(p.pending[0].kind === 'permission' && p.pending[0].toolName === 'Bash' && p.pending[0].summary.length <= 200 && p.activity.length <= 120 && p.detail.kind === 'permission', 'a Bash permission keeps summary <= 200 and activity <= 120')
    h.hook('PostToolUse', { toolUseId: 'p1' }); h.hook('Stop'); h.flush()
    check(h.last().state === 'done' && h.last().activity === undefined, 'activity disappears once the agent stops')
    h.hook('UserPromptSubmit', { prompt: 'z' }); h.hook('Notification', { notificationType: 'permission_prompt' })
    check(h.last().pending[0].id === 'fallback:permission' && h.last().pending[0].summary === '', 'a fallback permission is listed with an empty summary')
  }
  // Title-only tracks and topic (E5-FR-02).
  {
    const h = rich()
    h.manager.reportTitle('pane', '\u2802 Fix login')
    check(h.last().precise === false && h.last().topic === 'Fix login' && h.last().pending === undefined && h.last().lastMessage === undefined, 'approximate tracks get the topic but no reply, tool or pending')
    h.manager.reportTitle('pane', '\u2733 Fix login')
    check(h.last().state === 'action' && h.last().pending === undefined, 'a title stop is action without pending detail')
    h.hook('SessionStart'); h.manager.reportTitle('pane', '\u2802 Refactor auth'); h.flush()
    check(h.last().precise === true && h.last().topic === 'Refactor auth', 'the topic is captured while the pane is precise')
    h.manager.reportTitle('pane', '\u2733 Claude Code'); h.manager.reportTitle('pane', 'claude'); h.flush()
    check(h.last().topic === 'Refactor auth', 'a generic title never overwrites a valid topic')
  }
  // Session id rules (E4-FR-09 d).
  {
    const h = rich()
    h.manager.onAgentEvent({ paneId: 'pane', ptyId: 'pty', provider: 'codex', sessionId: 'launch:0011223344556677', kind: 'start' })
    check(h.last().sessionId === undefined && h.last().state === 'idle', 'a Codex launch: placeholder id is never emitted')
    h.manager.onAgentEvent({ paneId: 'pane', ptyId: 'pty', provider: 'codex', sessionId: SID, kind: 'start', cwd: process.cwd() })
    check(h.last().sessionId === SID && h.last().cwd === process.cwd() && h.last().provider === 'codex', 'a valid id and cwd reach the renderer')
    const ssh = rich({ config: { workspaces: [{ id: 'w', setupId: 'conn', panes: [{ id: 'pane' }] }] } })
    ssh.hook('SessionStart', { cwd: process.cwd() })
    check(ssh.last().precise && ssh.last().sessionId === undefined, 'a console behind a Connection Profile never emits its session id')
    const own = rich({ config: { workspaces: [{ id: 'w', setupId: 'conn', panes: [{ id: 'pane', setupId: '' }] }] } })
    own.hook('SessionStart')
    check(own.last().sessionId === SID, 'pane.setupId overrides the workspace profile, as in launch.ts')
  }
  // Throttle (E5-FR-02 AC: 10 PreToolUse in 1 s -> at most 2 emissions).
  {
    const h = rich()
    h.hook('UserPromptSubmit', { prompt: 'x' })
    const before = h.events.length
    for (let i = 0; i < 10; i++) { h.tick(100); h.hook('PreToolUse', { toolName: 'Read', toolSummary: `Read f${i}.ts` }) }
    h.flush()
    check(h.events.length - before <= 2 && h.last().activity === 'Read f9.ts', '10 PreToolUse in one second produce at most 2 emissions, the last tool wins')
    const n = h.events.length
    h.hook('PermissionRequest', { toolUseId: 'r', toolName: 'Bash', toolSummary: 'Bash: rm' })
    check(h.events.length === n + 1 && h.last().state === 'action', 'a state change is emitted at once even inside the throttle window')
    h.hook('PostToolUse', { toolUseId: 'r' })
    check(h.events.length === n + 2 && h.last().state === 'working' && h.last().pending === undefined, 'resolving a pending request is emitted at once')
    // Real Claude pairs every PreToolUse with a PostToolUse: those must not defeat the throttle.
    const h2 = rich()
    h2.hook('UserPromptSubmit', { prompt: 'x' })
    const start = h2.events.length
    for (let i = 0; i < 10; i++) {
      h2.tick(50); h2.hook('PreToolUse', { toolName: 'Read', toolUseId: `t${i}`, toolSummary: `Read g${i}.ts` })
      h2.tick(50); h2.hook('PostToolUse', { toolUseId: `t${i}` })
    }
    h2.flush()
    check(h2.events.length - start <= 3 && h2.last().activity === 'Read g9.ts' && h2.heard.length === h2.events.length, '10 PreToolUse/PostToolUse pairs in one second stay throttled')
  }
  // Listener seam (E1-FR-01) and SessionEnd parsing for E6-FR-21.
  {
    const h = rich()
    h.hook('SessionStart', { cwd: process.cwd() }); h.hook('SessionEnd', { endReason: 'prompt_input_exit', cwd: process.cwd() })
    const end = h.causes.at(-1)
    check(h.heard.length === h.events.length && end.kind === 'end' && end.endReason === 'prompt_input_exit' && end.cwd === process.cwd(), 'listeners hear every emission with the SessionEnd reason and cwd as cause')
    h.manager.onExit('pty', 'pane')
    check(h.heard.at(-1).state === null && h.heard.at(-1).paneId === 'pane', 'listeners hear state:null when the pty dies')
    h.off(); h.manager.onSpawn('pty2', 'pane'); h.manager.onHookEvent({ consoleId: 'pane', ptyId: 'pty2', sessionId: SID, name: 'SessionStart' })
    check(h.heard.at(-1).state === null, 'a removed listener hears nothing more')
    const boom = rich(); boom.manager.addListener(() => { throw new Error('x') })
    const quiet = console.warn; console.warn = () => {}
    try { boom.hook('SessionStart') } finally { console.warn = quiet }
    check(boom.last().state === 'idle', 'a failing listener never breaks the renderer emission')
  }
  // Transcript fallback when Stop has no last_assistant_message (E1-FR-09).
  {
    const asked = []
    let resolveRead
    const h = rich({ reader: (p, s) => { asked.push([p, s]); return new Promise(r => { resolveRead = r }) } })
    h.hook('UserPromptSubmit', { prompt: 'x', transcriptPath: 'C:/fake/projects/a/' + SID + '.jsonl' })
    h.hook('Stop')
    check(asked.length === 1 && asked[0][1] === SID, 'Stop without a reply reads the validated transcript of the session')
    resolveRead('Respuesta desde el transcript'); await new Promise(r => setImmediate(r)); h.flush()
    check(h.last().state === 'done' && h.last().lastMessage === 'Respuesta desde el transcript' && h.last().detail.text === 'Respuesta desde el transcript', 'the transcript reply becomes lastMessage and the reply detail')
    h.hook('Stop', { lastAssistantMessage: 'directo' }); h.flush()
    check(asked.length === 1, 'a Stop that carries the reply never opens the transcript')
    const none = rich({ reader: () => { throw new Error('must not read') } }); none.hook('Stop'); none.flush()
    check(none.last().state === 'done', 'without a validated transcript nothing is read')
  }

  // Pure helpers.
  const d = load('src/main/status/statusDetails.ts')
  check(d.summarizeTool('Edit', { file_path: 'C:\\repo\\src\\app.ts' }) === 'Edit app.ts' && d.summarizeTool('Bash', { command: '\n  npm test -- --watch\nsecond' }) === 'Bash: npm test -- --watch', 'file and Bash tool summaries')
  check(d.summarizeTool('Grep', { pattern: 'x'.repeat(80) }).length <= 48 && d.summarizeTool('WebFetch', { url: 'https://example.com/a?b' }) === 'WebFetch example.com' && d.summarizeTool('mcp__github__create_issue', {}) === 'mcp github.create_issue' && d.summarizeTool('Task', { description: 'Explore' }) === 'Task: Explore' && d.summarizeTool('Other', {}) === 'Other', 'search, fetch, MCP, Task and generic summaries')
  check(d.summarizeRequest('Bash', { command: 'git push ' + 'o'.repeat(300) }).length <= 200 && d.summarizeRequest('ExitPlanMode', { plan: '# Plan\n1. hacer' }) === 'Plan', 'request summaries stay within 200')
  check(d.firstLine('\n\n## **Hecho** con `exito`\nresto') === 'Hecho con exito' && d.sanitize('a\u001b[31mb\u0007c\u009bd') === 'abcd', 'firstLine drops markdown markers; sanitize drops ANSI, C0 and C1')
  check(d.clip('\ud83d\ude00'.repeat(10), 5).length <= 5 && !/[\ud800-\udbff]\u2026$/.test(d.clip('a\ud83d\ude00\ud83d\ude00', 3)), 'clip never splits a surrogate pair')
  const qs = d.extractQuestions({ questions: [{ question: 'Q?', header: 'H', multiSelect: true, options: [{ label: 'uno', description: 'd' }, { nope: 1 }] }, { question: '' }, 'x'] })
  check(qs.length === 1 && qs[0].multiSelect === true && qs[0].options.length === 1 && qs[0].options[0].description === 'd' && d.extractQuestions({}) === undefined, 'questions extracted bounded and validated')

  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-claude-test-'))
  try {
    const projects = path.join(claudeDir, 'projects', 'C--repo')
    fs.mkdirSync(projects, { recursive: true })
    const good = path.join(projects, SID + '.jsonl')
    check(d.isSafeTranscriptPath(good, SID, claudeDir), 'a transcript inside projects is accepted (even before its first write)')
    check(!d.isSafeTranscriptPath(path.join(claudeDir, 'projects', '..', '..', SID + '.jsonl'), SID, claudeDir) && !d.isSafeTranscriptPath('C:\\Users\\x\\.claude\\projects\\..\\..\\secret.jsonl', 'secret', claudeDir), 'traversal is rejected')
    check(!d.isSafeTranscriptPath(path.join(projects, SID + '.json'), SID, claudeDir) && !d.isSafeTranscriptPath(path.join(projects, 'other.jsonl'), SID, claudeDir), 'wrong extension or a foreign basename is rejected')
    check(!d.isSafeTranscriptPath(path.join(os.tmpdir(), SID + '.jsonl'), SID, claudeDir) && !d.isSafeTranscriptPath('relative/' + SID + '.jsonl', SID, claudeDir) && !d.isSafeTranscriptPath(good, '', claudeDir), 'outside projects, relative or without session is rejected')
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hola' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Primera respuesta' }] } }),
      'x'.repeat(70 * 1024),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Ultima\nrespuesta' }, { type: 'tool_use', name: 'Bash' }] } }),
      JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagente' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } }),
      '{broken',
    ]
    fs.writeFileSync(good, lines.join('\n') + '\n')
    check(await d.readLastAssistantMessage(good, SID, claudeDir) === 'Ultima\nrespuesta', 'the fallback reads the newest main-thread assistant text from the 64 KB tail')
    fs.writeFileSync(good, lines.slice(0, 3).join('\n'))
    check(await d.readLastAssistantMessage(good, SID, claudeDir) === undefined, 'nothing older than the 64 KB tail is read')
    check(await d.readLastAssistantMessage(path.join(projects, 'missing.jsonl'), 'missing', claudeDir) === undefined && await d.readLastAssistantMessage(path.join(os.tmpdir(), 'x.jsonl'), 'x', claudeDir) === undefined, 'missing or outside files resolve to undefined')
    check(d.isSafeCwd(claudeDir) && !d.isSafeCwd('relative') && !d.isSafeCwd(path.join(claudeDir, 'nope')) && !d.isSafeCwd(good), 'cwd must be an absolute existing directory')

    // Real HTTP parsing (E5-FR-01 AC): fields bounded, invalid paths dropped, 200 empty, nothing logged.
    const logged = []
    const capture = (...a) => logged.push(a.join(' '))
    const spy = { log: capture, warn: capture, error: capture, info: capture, debug: capture }
    const { HookServer: RichHookServer } = load('src/main/status/HookServer.ts', { console: spy, process: { ...process, env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir } } })
    const srv = new RichHookServer(), got = []
    srv.onEvent(e => got.push(e))
    const token = 'b'.repeat(32), port = await srv.start(0, token)
    try {
      const url = `http://127.0.0.1:${port}/cc-hook/${token}`
      const post = async body => { const r = await fetch(url, { method: 'POST', headers: { 'X-Console-Id': 'pane', 'X-Pty-Id': 'pty' }, body: typeof body === 'string' ? body : JSON.stringify(body) }); return [r.status, await r.text()] }
      const secret = 'SECRETO-' + 'p'.repeat(3000)
      let res = await post({ hook_event_name: 'UserPromptSubmit', session_id: SID, prompt: secret, cwd: claudeDir, transcript_path: good })
      check(res[0] === 200 && res[1] === '', 'enriched hooks still answer 200 with an empty body')
      let e = got.at(-1)
      check(e.prompt.length <= 2000 && e.prompt.startsWith('SECRETO-') && e.cwd === claudeDir && e.transcriptPath === good, 'UserPromptSubmit carries prompt (<= 2000), cwd and the validated transcript')
      await post({ hook_event_name: 'Stop', session_id: SID, last_assistant_message: 'r'.repeat(5000), transcript_path: path.join(claudeDir, 'projects', '..', '..', 'secret.jsonl'), cwd: 'relative' })
      e = got.at(-1)
      check(e.lastAssistantMessage.length <= 2000 && e.transcriptPath === undefined && e.cwd === undefined, 'Stop carries the reply; traversal transcript and relative cwd are dropped')
      await post({ hook_event_name: 'PreToolUse', session_id: SID, tool_name: 'Bash', tool_input: { command: 'npm run ' + 'x'.repeat(500) }, cwd: path.join(claudeDir, 'missing') })
      e = got.at(-1)
      check(e.toolSummary.length <= 160 && e.requestSummary.length <= 200 && e.toolSummary.startsWith('Bash: npm run') && e.cwd === undefined && !('toolInput' in e) && !('tool_input' in e), 'PreToolUse carries bounded summaries and never the raw tool_input')
      await post({ hook_event_name: 'PreToolUse', session_id: SID, tool_name: 'AskUserQuestion', tool_use_id: 'q', tool_input: { questions: [{ question: 'Seguimos?', multiSelect: false, options: [{ label: 'Si' }, { label: 'No' }] }] } })
      e = got.at(-1)
      check(e.question === 'Seguimos?' && e.questions[0].options.length === 2, 'AskUserQuestion carries the question and the structured questions')
      await post({ hook_event_name: 'SessionEnd', session_id: SID, reason: 'prompt_input_exit', cwd: claudeDir })
      e = got.at(-1)
      check(e.endReason === 'prompt_input_exit' && e.cwd === claudeDir, 'SessionEnd carries reason and cwd (E6-FR-21)')
      await post({ hook_event_name: 'SessionStart', session_id: 'other', transcript_path: good })
      check(got.at(-1).transcriptPath === undefined, 'a transcript of another session is dropped')
      const count = got.length
      res = await post('{"hook_event_name":"Stop","pad":"' + 'q'.repeat(2 * 1024 * 1024) + '"}')
      check(res[0] === 200 && res[1] === '' && got.length === count, 'a body over 2 MB is ignored with 200 empty')
      res = await post('{malformed ' + secret)
      check(res[0] === 200 && got.length === count, 'a malformed body is ignored with 200')
      check(logged.every(line => !line.includes('SECRETO') && !line.includes('rrrr') && !line.includes('Seguimos')), 'no console output carries hook content')
    } finally { await srv.stop() }
  } finally { fs.rmSync(claudeDir, { recursive: true, force: true }) }

  // Renderer mirror: setPaneStatus copies the new fields and writes pane.lastSession on change only.
  const saves = [], timers = new Map()
  let seq = 0
  const r = loadRenderer(`export { startPersistence } from './persist'; export { useAppStore } from './store'`, {
    window: { snApi: { config: { save: cfg => saves.push(JSON.parse(JSON.stringify(cfg))) } } },
    document: { hasFocus: () => false },
    setTimeout: fn => { timers.set(++seq, fn); return seq }, clearTimeout: id => timers.delete(id),
  })
  const S = r.useAppStore
  S.getState().hydrate({ version: 11, workspaces: [{ id: 'w1', name: 'W', cwd: '', panes: [{ id: 'p1', type: 'claude', title: 'Claude', color: '#fff', icon: 'claude' }] }], presets: [], settings: S.getState().settings, activeWorkspaceId: 'w1' })
  const stop = r.startPersistence()
  const flushSaves = () => { const fns = [...timers.values()]; timers.clear(); fns.forEach(fn => fn()) }
  S.getState().setPaneStatus({ paneId: 'p1', state: 'working', precise: true, notify: false, provider: 'claude', updatedAt: 5, stateSince: 4, lastMessage: 'hola', activity: 'Read a.ts', pending: [{ id: 'x', kind: 'permission', summary: 's' }], detail: { kind: 'tool', text: 'Read a.ts' }, topic: 'T', firstPrompt: 'F', cacheSince: 3 })
  const ps = S.getState().paneStatus.p1
  check(ps.stateSince === 4 && ps.lastMessage === 'hola' && ps.activity === 'Read a.ts' && ps.pending[0].id === 'x' && ps.detail.kind === 'tool' && ps.topic === 'T' && ps.firstPrompt === 'F' && ps.cacheSince === 3, 'setPaneStatus copies the enrichment fields')
  flushSaves()
  check(saves.length === 0 && S.getState().workspaces[0].panes[0].lastSession === undefined, 'status without a session id never persists')
  S.getState().setPaneStatus({ paneId: 'p1', state: 'idle', precise: true, notify: false, provider: 'claude', updatedAt: 9, sessionId: SID, cwd: 'C:\\repo' })
  flushSaves()
  const ls = S.getState().workspaces[0].panes[0].lastSession
  check(ls && ls.sessionId === SID && ls.provider === 'claude' && ls.cwd === 'C:\\repo' && ls.at === 9 && saves.length === 1 && saves[0].workspaces[0].panes[0].lastSession.sessionId === SID, 'a valid session id is mirrored to pane.lastSession and persisted once')
  const ref = S.getState().workspaces
  S.getState().setPaneStatus({ paneId: 'p1', state: 'working', precise: true, notify: false, provider: 'claude', updatedAt: 12, sessionId: SID, cwd: 'C:\\repo' })
  S.getState().setPaneStatus({ paneId: 'p1', state: 'working', precise: true, notify: false, provider: 'claude', updatedAt: 13, sessionId: SID })
  S.getState().setPaneStatus({ paneId: 'p1', state: 'working', precise: true, notify: false, provider: 'claude', updatedAt: 14, sessionId: SID, cwd: 'C:\\repo\\sub' })
  flushSaves()
  check(S.getState().workspaces === ref && saves.length === 1 && S.getState().workspaces[0].panes[0].lastSession.cwd === 'C:\\repo', 'the same session never rewrites the config, not even after a cd')
  check(parseConfig(saves[0]).workspaces[0].panes[0].lastSession.sessionId === SID, 'the mirrored lastSession passes the schema 11 validation')
  S.getState().setPaneStatus({ paneId: 'p1', state: null, precise: false, notify: false })
  check(S.getState().paneStatus.p1 === undefined && S.getState().workspaces[0].panes[0].lastSession.sessionId === SID, 'state:null clears the status but keeps the lastSession mirror')
  stop()
}

main().catch(error => { console.error(error); process.exitCode = 1 })
