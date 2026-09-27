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
const { notificationSettingsSchema } = load('src/main/store/schema.ts')
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
      process: { ...process, argv: ['node', 'runtime', ...args], env: { SNMULTICC_REAL_CODEX: 'codex', SNMULTICC_CODEX_URL: 'ws://127.0.0.1:1' } },
      require: id => id === 'ws' ? { WebSocket: LaunchSocket } : id === 'child_process' ? { spawn: (_exe, actual) => { launched = actual; return new (require('events').EventEmitter)() } } : require(id),
    })
    await new Promise(resolve => setImmediate(resolve))
    check((launched[0] === '--remote') === remote, 'launcher preserves command arguments: ' + args.join(' '))
  }

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'snmulticc-hooks-test-'))
  const { CodexBridge } = load('src/main/status/CodexBridge.ts')
  const bridge = new CodexBridge(() => path.join(temporary, 'launcher'), 'test-runtime.js', () => {})
  bridge.findExecutable = () => process.execPath
  try {
    await bridge.configure(true)
    const env = bridge.environment('test-pty', 'test-pane', temporary)
    const WebSocket = require('ws')
    for (const headers of [{}, { Authorization: 'Bearer incorrect' }, { Authorization: 'Bearer ' + env.SNMULTICC_CODEX_TOKEN, Origin: 'https://example.test' }]) {
      const rejected = await new Promise(resolve => { const socket = new WebSocket(env.SNMULTICC_CODEX_URL, { headers }); socket.once('error', () => resolve(true)); socket.once('open', () => { socket.close(); resolve(false) }) })
      check(rejected, 'Codex bridge rejects missing/wrong token and browser origins')
    }
    const accepted = await new Promise((resolve, reject) => {
      const socket = new WebSocket(env.SNMULTICC_CODEX_URL, { headers: { Authorization: 'Launch ' + env.SNMULTICC_CODEX_TOKEN } })
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
      const child = require('child_process').spawn(process.platform === 'win32' ? 'powershell.exe' : '/bin/sh', process.platform === 'win32' ? command.split(' ').slice(1) : ['-c', command], { env: { ...process.env, SNMULTICC_CONSOLE_ID: 'pane', SNMULTICC_PTY_ID: 'pty' }, windowsHide: true, timeout: 10000 })
      child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error('SessionStart relay exit ' + code)))
      child.stdin.end(body)
    })
    check(received.length === 1 && received[0].sessionId === 'session-\u00f1' && received[0].ptyId === 'pty', 'real SessionStart command relays UTF-8 and PTY identity')
    const endpoint = `http://127.0.0.1:${port}/cc-hook/${token}`
    const response = await fetch(endpoint, { method: 'POST', headers: { 'X-Console-Id': 'pane', 'X-Pty-Id': 'pty' }, body: JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'session', tool_use_id: 'tool-id', tool_name: 'Bash' }) })
    check(response.status === 200 && await response.text() === '' && received.at(-1).toolUseId === 'tool-id', 'HTTP observer forwards request identity without returning a decision')
    check((await fetch(endpoint + 'wrong', { method: 'POST', body })).status === 404 && received.length === 2, 'wrong hook token rejected')
    await fetch(endpoint, { method: 'POST', body }); check(received.length === 2, 'hooks outside SnMultiCC ignored')
    data.hooks.PermissionRequest = []; fs.writeFileSync(file, JSON.stringify(data))
    check(!installer.hooksUpToDate(port, token), 'partial installation detected')
    installer.installHooks(port, token); installer.uninstallHooks()
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
    check(data.hooks.Stop[0].hooks[0].command === 'user-command' && data.custom === 'español', 'uninstall preserves unrelated settings')
    fs.writeFileSync(file, '{broken')
    assert.throws(() => installer.installHooks(port, token)); checks++
    check(fs.readFileSync(file, 'utf8') === '{broken', 'corrupt settings never overwritten')
  } finally { await server.stop(); fs.rmSync(temporary, { recursive: true, force: true }) }
  console.log(`PASS: ${checks} status, protocol, visibility, Discord and installer checks`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
