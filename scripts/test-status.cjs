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
  console.log(`PASS: ${checks} status, protocol, visibility, Discord, installer, schema 11 and store checks`)
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
  const d = parseConfig(v11)
  check(d && d.settings.terminalRenderer === 'canvas' && d.settings.awakeMode === 'auto' && d.settings.terminalUnicode11 === true, 'junk renderer, awake mode and Unicode values fall back without rejecting the config')
  check(d.settings.agents.resumeOnStartup === 'auto' && d.settings.agents.ctrlDigitFocus === false && d.settings.agents.topicAsTitle === true, 'partial agents settings keep values and default the rest')
  check(d.workspaces[0].agentsCollapsed === true && d.workspaces[1].agentsCollapsed === undefined, 'agentsCollapsed kept, malformed value dropped')
  check(d.workspaces[0].panes[0].lastSession.sessionId.startsWith('0123abcd') && d.workspaces[0].panes[1].lastSession === undefined, 'valid lastSession kept, malformed one dropped instead of failing the whole config')
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
  stop()
}

main().catch(error => { console.error(error); process.exitCode = 1 })
