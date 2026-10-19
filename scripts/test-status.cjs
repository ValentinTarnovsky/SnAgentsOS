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
function harness(opts = {}) {
  const events = [], notices = [], timers = new Map()
  let seq = 0, focused = false
  // `now`: a controllable clock for Date.now() inside StatusManager (v2.2 waits and TTLs).
  const clock = opts.now ? { Date: class extends Date { static now() { return opts.now() } } } : {}
  const { StatusManager, SUB_SESSION_GRACE_MS, SUB_SESSION_TTL_MS, BACKGROUND_WAIT_TTL_MS } = load('src/main/status/StatusManager.ts', {
    require: id => id === 'electron' ? { Notification: { isSupported: () => false } } : require(id),
    setTimeout: fn => { timers.set(++seq, fn); return seq }, clearTimeout: id => timers.delete(id),
    ...clock,
  })
  const manager = new StatusManager(() => ({ isDestroyed: () => false, isFocused: () => focused, webContents: { send: (_ch, e) => events.push(e) }, flashFrame() {} }), () => null, n => notices.push(n))
  manager.setConfig(settings); manager.onSpawn('pty', 'pane')
  const event = (kind, rest = {}) => manager.onAgentEvent({ paneId: 'pane', ptyId: 'pty', provider: 'claude', sessionId: 'session', kind, ...rest })
  const hook = (name, rest = {}) => manager.onHookEvent({ consoleId: 'pane', ptyId: 'pty', sessionId: 'session', name, ...rest })
  const flush = () => { const fns = [...timers.values()]; timers.clear(); fns.forEach(fn => fn()) }
  const states = () => events.filter(e => 'state' in e)
  const ends = () => events.filter(e => !('state' in e) && 'reason' in e && 'at' in e)
  return { manager, event, hook, events, notices, flush, focused: v => { focused = v }, last: () => states().at(-1), ends, SUB_SESSION_GRACE_MS, SUB_SESSION_TTL_MS, BACKGROUND_WAIT_TTL_MS }
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
    // The workspace badge read 2: AskUserQuestion and ExitPlanMode also go
    // through a permission prompt, and PermissionRequest carries no tool_use_id.
    const h = harness(); h.hook('UserPromptSubmit')
    h.hook('PreToolUse', { toolName: 'AskUserQuestion', toolUseId: 'q' })
    h.hook('PermissionRequest', { toolName: 'AskUserQuestion' })
    h.hook('Notification', { notificationType: 'permission_prompt' })
    check(h.last().pendingCount === 1 && h.notices.length === 1, 'a question plus its permission prompt and its notification is one request and one notice')
    h.hook('PostToolUse', { toolUseId: 'q' }); check(h.last().state === 'working' && h.last().pendingCount === 0, 'answering the question clears it')
    h.hook('PermissionRequest', { toolName: 'ExitPlanMode' })
    h.hook('PreToolUse', { toolName: 'ExitPlanMode', toolUseId: 'p' })
    check(h.last().pendingCount === 1 && h.last().reason === 'plan' && h.notices.length === 2, 'a plan whose permission prompt came first is promoted, not doubled')
    h.hook('PostToolUse', { toolUseId: 'p' })
    h.hook('PermissionRequest', { toolName: 'Bash' })
    check(h.last().pendingCount === 1 && h.notices.length === 3, 'a plain permission without tool_use_id is still one request')
    h.hook('Notification', { notificationType: 'elicitation_dialog' })
    check(h.last().pendingCount === 1 && h.notices.length === 3, 'a notification while anything is pending adds nothing')
  }
  {
    // v2.2: a driver's `claude -p` (a sub-session) never stands for the console's own Claude.
    let clock = 1_000_000
    const h = harness({ now: () => clock })
    const done = () => h.notices.filter(n => n.state === 'done').length
    h.hook('SessionStart', { source: 'startup' }); h.hook('UserPromptSubmit'); h.hook('PreToolUse', { toolName: 'Bash' })
    h.hook('SessionStart', { sessionId: 'sub-1', source: 'startup' })
    check(h.manager.paneForSession('session') === 'pane' && h.last().state === 'working', 'a startup of another session while the console\'s own lives is held, not adopted')
    h.hook('UserPromptSubmit', { sessionId: 'sub-1', nested: true }); h.hook('PreToolUse', { sessionId: 'sub-1', nested: true, toolName: 'Read' })
    h.hook('Stop', { sessionId: 'sub-1', nested: true }); h.flush()
    check(h.manager.paneForSession('session') === 'pane' && h.manager.paneForSession('sub-1') === null && h.last().state === 'working' && done() === 0, 'its marked hooks never stand for the console (no done, no notice)')
    h.hook('SessionEnd', { sessionId: 'sub-1', nested: true, endReason: 'other' })
    check(h.ends().length === 0 && h.manager.paneForSession('session') === 'pane', 'its SessionEnd raises no "Claude exited" and keeps the console\'s session')
    // The console's Claude ends its turn while the driver runs in the background.
    h.hook('SessionStart', { sessionId: 'sub-2', source: 'startup', nested: true })
    h.hook('Stop'); h.flush()
    check(h.last().state === 'working' && h.last().waiting?.kind === 'subsessions' && h.last().waiting.count === 1 && done() === 0, 'a turn that ends with a sub-session alive is waiting, not done, and sends no notice')
    clock += 1000
    h.hook('SessionEnd', { sessionId: 'sub-2', nested: true, endReason: 'other' })
    check(h.last().state === 'working' && h.last().waiting.count === 0, 'between two sub-sessions of a driver the console keeps waiting (grace)')
    clock += h.SUB_SESSION_GRACE_MS + 10; h.flush()
    check(h.last().state === 'done' && !h.last().waiting && h.ends().length === 0, 'after the grace with no sub-session it reads done')
    h.hook('SessionStart', { sessionId: 'sub-3', source: 'startup', nested: true })
    check(h.last().state === 'working' && h.last().waiting.count === 1, 'a Codex-started sub-session (parent mark on SessionStart) waits at once')
    clock += h.SUB_SESSION_TTL_MS + 10; h.flush()
    check(h.last().state === 'done' && !h.last().waiting, 'a sub-session silent past its TTL is dropped')
  }
  {
    // v2.2: a held startup whose first hook is unmarked is the console's new Claude (the old one died silently).
    const h = harness()
    h.hook('SessionStart', { source: 'startup' }); h.hook('UserPromptSubmit'); h.hook('Stop'); h.flush()
    h.hook('SessionStart', { sessionId: 'fresh-session', source: 'startup' })
    check(h.manager.paneForSession('session') === 'pane', 'held until its first hook says what it is')
    h.hook('UserPromptSubmit', { sessionId: 'fresh-session' })
    check(h.manager.paneForSession('fresh-session') === 'pane' && h.manager.paneForSession('session') === null && h.last().state === 'working', 'an unmarked first hook makes it the console\'s session')
    h.hook('SessionStart', { sessionId: 'cleared-session', source: 'clear' })
    check(h.manager.paneForSession('cleared-session') === 'pane', 'a /clear switches at once (never held)')
  }
  {
    // v2.2: background work (Stop background_tasks) and turns the agent starts on its own.
    let clock = 5_000_000
    const h = harness({ now: () => clock })
    const done = () => h.notices.filter(n => n.state === 'done').length
    h.hook('UserPromptSubmit'); h.hook('Stop', { background: { waits: 1, other: 0 } }); h.flush()
    check(h.last().state === 'working' && h.last().waiting?.kind === 'background' && h.last().waiting.count === 1 && done() === 0, 'a turn that left a subagent or a snaos wait running is waiting, with no notice')
    h.hook('PreToolUse', { toolName: 'Read' }); h.hook('Stop'); h.flush()
    check(h.last().state === 'done' && !h.last().waiting && done() === 1, 'the turn it wakes up for (no UserPromptSubmit) notifies when it ends')
    h.hook('PreToolUse', { toolName: 'Bash' }); h.hook('Stop'); h.flush()
    check(done() === 2, 'every wake-up turn notifies again (the done key used to repeat)')
    h.hook('UserPromptSubmit'); h.hook('Stop', { background: { waits: 0, other: 2 } }); h.flush()
    check(h.last().state === 'done' && h.last().backgroundOther === 2 && done() === 3, 'a dev server left running does not hold the console: done, with the hint')
    h.hook('UserPromptSubmit'); h.hook('Stop', { background: { waits: 2, other: 0 } }); h.flush()
    check(h.last().waiting?.count === 2, 'two background tasks that come back')
    clock += h.BACKGROUND_WAIT_TTL_MS + 10; h.flush()
    check(h.last().state === 'done' && !h.last().waiting, 'the wait gives up after its TTL')
  }
  {
    // v2.2: Esc fires no Stop; a stopped title glyph with no hook for 2 s is idle.
    let clock = 9_000_000
    const h = harness({ now: () => clock })
    h.hook('UserPromptSubmit'); h.hook('PreToolUse', { toolName: 'Bash' })
    h.manager.reportTitle('pane', '✳ Topic'); clock += 2500; h.flush()
    check(h.last().state === 'idle' && h.notices.length === 0, 'an interrupted turn ends as idle without a notice')
    clock += 10; h.hook('UserPromptSubmit')
    h.manager.reportTitle('pane', '✳ Topic'); clock += 10; h.hook('PreToolUse', { toolName: 'Read' }); h.flush()
    check(h.last().state === 'working', 'a hook inside the window calls it off')
    h.manager.reportTitle('pane', '✳ Topic'); h.manager.reportTitle('pane', '⠂ Topic'); clock += 2500; h.flush()
    check(h.last().state === 'working', 'a working glyph calls it off')
    clock += 10; h.hook('Stop'); h.manager.reportTitle('pane', '✳ Topic'); h.flush()
    check(h.last().state === 'done', 'a normal Stop with the stopped glyph is done, not idle')
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
  // E5-FR-03 + E1-FR-08 (D12): the App Server contract of the installed CLI
  // (codex app-server generate-ts, ThreadItem v2) through StatusManager.
  {
    class NativeNotification extends require('events').EventEmitter { static isSupported() { return false } show() {} }
    const { StatusManager } = load('src/main/status/StatusManager.ts', { require: id => id === 'electron' ? { Notification: NativeNotification } : require(id) })
    const { codexItemTool } = load('src/main/status/CodexProtocol.ts')
    const manager = new StatusManager(() => null, () => null)
    manager.onSpawn('pty-c', 'pane-c')
    const raw = []
    const proto = new CodexProtocol('pane-c', 'pty-c', e => { raw.push(e); manager.onAgentEvent(e) })
    const send = (side, m) => proto[side](JSON.stringify(m))
    const thread = '019a1b2c-3d4e-7f80-9a1b-2c3d4e5f6a7b'
    send('client', { id: 1, method: 'thread/resume', params: { threadId: thread } })
    send('server', { id: 1, result: { thread: { id: thread, preview: 'arreglá el login\nmás texto', status: { type: 'idle' }, turns: [] } } })
    let st = manager.stateOf('pane-c')
    check(raw[0].kind === 'start' && st.firstPrompt === 'arreglá el login' && st.provider === 'codex', 'a resumed thread names its first prompt from thread.preview')
    send('server', { method: 'turn/started', params: { threadId: thread, turn: { id: 't1', items: [], status: 'inProgress' } } })
    send('server', { method: 'item/started', params: { threadId: thread, turnId: 't1', startedAtMs: 1, item: { type: 'userMessage', id: 'u1', clientId: null, content: [{ type: 'text', text: 'agregá tests\ncon detalle', text_elements: [] }, { type: 'localImage', path: 'C:\\x.png' }] } } })
    st = manager.stateOf('pane-c')
    check(st.state === 'working' && st.detail.kind === 'prompt' && st.detail.text === 'agregá tests' && st.firstPrompt === 'arreglá el login', 'a user message is the prompt detail and never replaces the first prompt')
    check(raw.at(-1).prompt === 'agregá tests\ncon detalle', 'the prompt text reaches the session store as the last prompt')
    send('server', { method: 'item/started', params: { threadId: thread, turnId: 't1', startedAtMs: 2, item: { type: 'commandExecution', id: 'c1', command: '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "npm test"', commandActions: [{ type: 'unknown', command: 'npm test' }], cwd: 'C:\\repo', processId: null, source: 'agent', status: 'inProgress', aggregatedOutput: null, exitCode: null, durationMs: null, pluginId: null, scriptPath: null } } })
    st = manager.stateOf('pane-c')
    check(st.detail.kind === 'tool' && st.detail.text === 'npm test' && st.activity === 'npm test', 'commandExecution shows its (parsed) command as the detail and the phone activity')
    check(codexItemTool({ type: 'commandExecution', command: 'git status\nsecond line', commandActions: [] }) === 'git status', 'without parsed actions the first command line is used')
    check(codexItemTool({ type: 'commandExecution', command: 'echo \x1b[31mred\x1b[0m', commandActions: [] }) === 'echo red', 'ANSI escapes never reach the detail')
    send('server', { method: 'item/started', params: { threadId: thread, turnId: 't1', startedAtMs: 3, item: { type: 'fileChange', id: 'f1', status: 'inProgress', changes: [{ path: 'C:\\repo\\src\\login.ts', kind: { type: 'update', move_path: null }, diff: '' }, { path: 'C:\\repo\\b.ts', kind: { type: 'add' }, diff: '' }] } } })
    check(manager.stateOf('pane-c').detail.text === 'Edit login.ts +1', 'fileChange names its file (and how many more)')
    check(codexItemTool({ type: 'mcpToolCall', server: 'docs', tool: 'search' }) === 'mcp docs.search' && codexItemTool({ type: 'reasoning' }) === undefined, 'MCP calls read like Claude rows; non-tool items carry no detail')
    send('server', { method: 'item/completed', params: { threadId: thread, turnId: 't1', completedAtMs: 4, item: { type: 'agentMessage', id: 'a1', text: 'Voy a correr los tests', phase: 'commentary', memoryCitation: null, delivery: null, questions: null } } })
    st = manager.stateOf('pane-c')
    check(st.state === 'working' && st.detail.kind === 'reply' && st.detail.text === 'Voy a correr los tests' && st.lastMessage === undefined, 'commentary mid-turn is the detail, not yet the last message')
    const long = 'x'.repeat(400)
    send('server', { method: 'item/completed', params: { threadId: thread, turnId: 't1', completedAtMs: 5, item: { type: 'agentMessage', id: 'a2', text: '## Listo\nTodos los tests pasan. ' + long, phase: 'final_answer', memoryCitation: null, delivery: null, questions: null } } })
    send('server', { method: 'turn/completed', params: { threadId: thread, turn: { id: 't1', status: 'completed', items: [] } } })
    st = manager.stateOf('pane-c')
    check(st.state === 'done' && st.lastMessage.startsWith('## Listo Todos los tests pasan.') && st.lastMessage.length === 280, 'the completed agentMessage is published as lastMessage, cut to 280 like Claude')
    check(st.detail.kind === 'reply' && st.detail.text === 'Listo' && st.activity === undefined, 'done shows the first line of the reply as its detail')
    check(raw.at(-1).kind === 'done' && raw.at(-1).reply.length <= 2000, 'the reply rides the done event, bounded in memory')
    send('server', { method: 'turn/started', params: { threadId: thread, turn: { id: 't2' } } })
    send('server', { method: 'turn/completed', params: { threadId: thread, turn: { id: 't2', status: 'interrupted' } } })
    check(raw.at(-1).kind === 'idle' && raw.at(-1).reply === undefined, 'an interrupted turn publishes no reply')
    const n = raw.length
    send('server', { method: 'item/started', params: { threadId: 'child-thread', turnId: 'x', item: { type: 'commandExecution', command: 'rm -rf /', commandActions: [] } } })
    send('server', { method: 'item/completed', params: { threadId: thread, item: { type: 'agentMessage', id: 'late', text: 'late' } } })
    check(raw.length === n, 'a child thread and an agentMessage outside a turn change nothing')
    // A fresh thread (no preview) takes its first prompt from the first user message.
    const proto2 = new CodexProtocol('pane-c', 'pty-c', e => manager.onAgentEvent(e))
    proto2.client(JSON.stringify({ id: 7, method: 'thread/start' }))
    proto2.server(JSON.stringify({ id: 7, result: { thread: { id: '019a1b2c-0000-7f80-9a1b-2c3d4e5f6a7c', preview: '', status: { type: 'idle' } } } }))
    check(manager.stateOf('pane-c').firstPrompt === undefined, 'a new thread starts without a first prompt')
    proto2.server(JSON.stringify({ method: 'turn/started', params: { threadId: '019a1b2c-0000-7f80-9a1b-2c3d4e5f6a7c', turn: { id: 'n1' } } }))
    proto2.server(JSON.stringify({ method: 'item/started', params: { threadId: '019a1b2c-0000-7f80-9a1b-2c3d4e5f6a7c', item: { type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'explicá el repo' }] } } }))
    check(manager.stateOf('pane-c').firstPrompt === 'explicá el repo', 'the first user message of the thread sets firstPrompt')
    manager.dispose()
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
  const { HookServer, backgroundTasks, nestedFromHeaders, parseHookPayload } = load('src/main/status/HookServer.ts')
  // v2.2: Stop background_tasks and the sub-session marks.
  const bg = backgroundTasks([
    { type: 'local_agent', status: 'running', description: 'Explore the repo' },
    { type: 'shell', status: 'running', description: 'snaos wait 2 --idle --timeout 110' },
    { type: 'local_bash', status: 'running', command: 'bash sn-drive.sh' },
    { type: 'shell', status: 'running', description: 'npm run dev' },
    { type: 'shell', status: 'completed', description: 'snaos wait 3 --idle' },
    { type: 'monitor', status: 'running', description: 'watch logs' },
    null, 'x',
  ])
  check(bg.waits === 3 && bg.other === 2, 'background tasks: a subagent, a snaos wait and a driver come back; a dev server and a monitor do not; finished ones are gone')
  check(backgroundTasks([]) === undefined && backgroundTasks(null) === undefined && backgroundTasks([{ type: 'shell', status: 'killed' }]) === undefined, 'nothing running is no background')
  check(parseHookPayload('pane', 'pty', 'Stop', { session_id: 's', background_tasks: [{ type: 'subagent', status: 'running' }] }).background.waits === 1, 'Stop carries its background tasks')
  check(parseHookPayload('pane', 'pty', 'SessionStart', { session_id: 's', source: 'startup' }).source === 'startup', 'SessionStart carries its source')
  check(nestedFromHeaders('1', '') && nestedFromHeaders(undefined, 'codex:pane-1') && !nestedFromHeaders('', '') && !nestedFromHeaders('0', 'codex:bad id') && !nestedFromHeaders(undefined, undefined), 'sub-session marks: child 1 or a valid parent')
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
    // v2.2: sub-session marks.
    const stopBody = JSON.stringify({ hook_event_name: 'Stop', session_id: 'sub' })
    check(data.hooks.Stop.some(g => g.hooks.some(hk => hk.headers?.['X-Agent-Child'] === '$CLAUDE_CODE_CHILD_SESSION' && hk.headers?.['X-Agent-Parent'] === '$' + AGENT_ENV.agentParent && hk.allowedEnvVars.includes('CLAUDE_CODE_CHILD_SESSION'))), 'HTTP handlers forward the sub-session marks')
    await fetch(endpoint, { method: 'POST', headers: { 'X-Console-Id': 'pane', 'X-Pty-Id': 'pty', 'X-Agent-Child': '1' }, body: stopBody })
    check(received.at(-1).nested === true, 'X-Agent-Child: 1 marks a sub-session')
    await fetch(endpoint, { method: 'POST', headers: { 'X-Console-Id': 'pane', 'X-Pty-Id': 'pty', 'X-Agent-Child': '', 'X-Agent-Parent': '' }, body: stopBody })
    check(received.at(-1).nested === undefined, 'empty marks are the console\'s own agent')
    await fetch(endpoint, { method: 'POST', headers: { 'X-Console-Id': 'pane', 'X-Pty-Id': 'pty', 'X-Agent-Child': '$CLAUDE_CODE_CHILD_SESSION', 'X-Agent-Parent': '$SNAOS_AGENT_PARENT' }, body: stopBody })
    check(received.at(-1).nested === undefined, 'uninterpolated marks are not a sub-session')
    await new Promise((resolve, reject) => {
      const child = require('child_process').spawn(process.platform === 'win32' ? 'powershell.exe' : '/bin/sh', process.platform === 'win32' ? command.split(' ').slice(1) : ['-c', command], { env: { ...process.env, [AGENT_ENV.consoleId]: 'pane', [AGENT_ENV.ptyId]: 'pty', [AGENT_ENV.agentParent]: 'codex:pane-1' }, windowsHide: true, timeout: 10000 })
      child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error('SessionStart relay exit ' + code)))
      child.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'codex-sub', source: 'startup' }))
    })
    check(received.at(-1).sessionId === 'codex-sub' && received.at(-1).nested === true && received.at(-1).source === 'startup', 'the SessionStart command forwards the parent mark of a Codex console')
    received.length = 2
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
  ntfyConfigChecks()
  await ntfyChannelChecks()
  await enrichmentChecks()
  await pathOpenChecks()
  await firewallChecks()
  connLogRedactChecks()
  promptCardChecks()
  console.log(`PASS: ${checks} status, protocol, visibility, Discord, installer, schema 11/12, ntfy export, ntfy channel, away gate, lastHost, store, enrichment, Codex App Server detail, path open, firewall, connection log and answer card checks`)
}

// R22-16 (E2-FR-28..30): shell:openPath containment in main with real files and
// a real junction, the renderer's openPath/openUrl executor (roots from the
// store, SSH denied, retry with the workspace root) and the ctl schemas.
async function pathOpenChecks() {
  const { createPathOpener, classifyRoot, validatePath, isInside } = load('src/main/remote/pathOpen.ts')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-pathopen-'))
  try {
    const root = path.join(tmp, 'ws'), outside = path.join(tmp, 'outside'), home = path.join(tmp, 'home')
    for (const d of [root, path.join(root, 'src'), outside, home]) fs.mkdirSync(d, { recursive: true })
    for (const f of [path.join(root, 'notes.md'), path.join(root, 'src', 'App.tsx'), path.join(root, 'run.js'), path.join(root, 'tool.exe'), path.join(outside, 'secret.md'), path.join(home, 'notas.md')]) fs.writeFileSync(f, 'x')
    fs.symlinkSync(outside, path.join(root, 'escape'), 'junction')
    const alias = path.join(tmp, 'alias')
    fs.symlinkSync(root, alias, 'junction')
    const real = p => fs.realpathSync.native(p)
    let now = 10000, openErr = ''
    const opened = [], revealed = []
    const opener = createPathOpener({ openPath: async p => { opened.push(p); return openErr }, showItemInFolder: p => revealed.push(p), homedir: () => home, now: () => now })
    const call = async (cwd, p) => { now += 1500; return opener({ cwd, path: p }) }

    let r = await call(root, 'src/App.tsx:12')
    check(r.ok && revealed.at(-1) === real(path.join(root, 'src', 'App.tsx')) && opened.length === 0, 'src/App.tsx:12 drops the suffix and is revealed, not opened')
    r = await call(root, 'notes.md')
    check(r.ok && opened.at(-1) === real(path.join(root, 'notes.md')), 'an inert .md inside the root opens')
    r = await call(root, 'run.js')
    check(r.ok && opened.length === 1 && revealed.at(-1) === real(path.join(root, 'run.js')), 'a .js is revealed, never opened (Windows Script Host)')
    r = await call(root, 'tool.exe:3:4')
    check(r.ok && opened.length === 1 && revealed.at(-1).endsWith('tool.exe'), 'a .exe is revealed, never run')
    r = await call(root, path.join('..', '..', 'Windows', 'System32', 'calc.exe'))
    check(!r.ok && r.error === 'denied_path', '..\\..\\Windows\\System32\\calc.exe is denied_path')
    r = await call(root, path.join(outside, 'secret.md'))
    check(!r.ok && r.error === 'denied_path', 'an absolute path outside the root is denied_path even when it exists')
    r = await call(root, 'escape/secret.md')
    check(!r.ok && r.error === 'denied_path', 'a junction that escapes the root is denied after realpath')
    r = await call(root, 'missing.md')
    check(!r.ok && r.error === 'not_found', 'a missing file is not_found')
    r = await call(alias, 'notes.md')
    check(r.ok && opened.at(-1) === real(path.join(root, 'notes.md')), 'a cwd that is itself a junction compares after realpath')
    const before = opened.length
    r = await call('', 'notas.md')
    check(r.ok && opened.length === before && revealed.at(-1) === real(path.join(home, 'notas.md')), 'an empty cwd means home, and under home even an .md is only revealed')
    check(classifyRoot(real(home), home) === 'home' && classifyRoot(real(root), home) === 'normal', 'classifyRoot tells home from a normal folder')
    check(classifyRoot(process.platform === 'win32' ? 'C:\\' : '/', home) === 'drive', 'a drive root classifies as drive')
    check(isInside('C:\\ws', 'c:\\WS\\a.txt', true) && !isInside('C:\\ws', 'C:\\ws2\\a.txt', true) && isInside('C:\\', 'C:\\x', true), 'containment is case-insensitive on win32 and has no prefix confusion')
    // Rate: one open or reveal per second in total; denied or missing paths do not spend it.
    now += 5000
    r = await opener({ cwd: root, path: 'notes.md' })
    const second = await opener({ cwd: root, path: 'notes.md' })
    check(r.ok && !second.ok && second.error === 'rate', 'two opens within a second: the second is rate')
    now += 1500
    const denied = await opener({ cwd: root, path: 'escape/secret.md' })
    const retry = await opener({ cwd: root, path: 'notes.md' })
    check(denied.error === 'denied_path' && retry.ok, 'a denied path does not spend the budget, so the workspace-root retry goes through')
    check((await opener({ cwd: 1, path: 'x' })).error === 'bad_request' && (await opener({ cwd: root, path: '  ' })).error === 'bad_request' && (await opener(null)).error === 'bad_request', 'malformed requests are bad_request')
    now += 1500; openErr = 'No application is associated'
    r = await opener({ cwd: root, path: 'notes.md' })
    check(r.ok && revealed.at(-1) === real(path.join(root, 'notes.md')), 'an inert file with no handler falls back to reveal')
    const v = validatePath(root, '"notes.md"', home)
    check(v.ok && v.rootKind === 'normal', 'surrounding quotes are dropped')
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }

  // Renderer executor: roots from the store, SSH denied without calling main, retry under ws.cwd.
  {
    const calls = [], external = []
    let answer = () => ({ ok: true })
    const rr = loadRenderer(`export { useAppStore } from './store'; export { runOpenPath, runOpenUrl, resolvePaneRoot } from './remoteOpen'`, {
      window: { snApi: { system: { openPath: async req => { calls.push(req); return answer(req) }, openExternal: u => external.push(u) }, pty: { killPanes: async () => 0 } } },
      document: { hasFocus: () => false },
      URL,
    })
    const pane = (id, extra = {}) => ({ id, type: 'shell', title: id, icon: 'terminal', ...extra })
    rr.useAppStore.setState({
      presets: [{ id: 'pr', name: 'P', type: 'claude', command: 'claude', icon: 'bot', color: '#fff', defaultCwd: 'D:/preset' }],
      workspaces: [
        { id: 'w', name: 'W', cwd: 'C:/ws', panes: [pane('p', { cwd: 'C:/ws/sub' }), pane('s', { setupId: 'ssh' }), pane('q', { presetId: 'pr' }), pane('n')] },
        { id: 'remote', name: 'R', cwd: 'C:/r', setupId: 'ssh', panes: [pane('r')] },
        { id: 'bare', name: 'B', cwd: '', panes: [pane('b'), pane('bc', { cwd: 'C:/elsewhere' })] },
      ],
    })
    check(rr.resolvePaneRoot('w', 'p') === 'C:/ws/sub' && rr.resolvePaneRoot('w', 'q') === 'D:/preset' && rr.resolvePaneRoot('w', 'n') === 'C:/ws' && rr.resolvePaneRoot('bare', 'b') === '', 'pane root: pane cwd, then preset defaultCwd, then ws.cwd, else empty (home)')
    answer = req => req.cwd === 'C:/ws/sub' ? { ok: false, error: 'denied_path' } : { ok: true }
    let res = await rr.runOpenPath({ kind: 'openPath', workspaceId: 'w', paneId: 'p', path: '../README.md' })
    check(res.ok && calls.length === 2 && calls[0].cwd === 'C:/ws/sub' && calls[1].cwd === 'C:/ws', 'denied under the pane root retries once under ws.cwd')
    calls.length = 0
    res = await rr.runOpenPath({ kind: 'openPath', workspaceId: 'w', paneId: 's', path: 'a.md' })
    const res2 = await rr.runOpenPath({ kind: 'openPath', workspaceId: 'remote', paneId: 'r', path: 'a.md' })
    check(res.error === 'denied_path' && res2.error === 'denied_path' && calls.length === 0, 'a pane or workspace with an SSH profile is denied_path without calling main')
    answer = () => ({ ok: false, error: 'denied_path' })
    res = await rr.runOpenPath({ kind: 'openPath', workspaceId: 'w', paneId: 'n', path: '../x' })
    check(res.error === 'denied_path' && calls.length === 1, 'no retry when the pane root already is ws.cwd')
    calls.length = 0
    res = await rr.runOpenPath({ kind: 'openPath', workspaceId: 'bare', paneId: 'bc', path: '../x' })
    check(res.error === 'denied_path' && calls.length === 1, 'no retry under home when the workspace has no cwd of its own')
    answer = () => ({ ok: false, error: 'not_found' }); calls.length = 0
    res = await rr.runOpenPath({ kind: 'openPath', workspaceId: 'w', paneId: 'p', path: 'nope.md' })
    check(res.error === 'not_found' && calls.length === 1, "main's error is copied to the ack (no retry for not_found)")
    res = await rr.runOpenPath({ kind: 'openPath', workspaceId: 'w', paneId: 'gone', path: 'a.md' })
    check(!res.ok && res.error === 'not_found', 'a pane that no longer exists is not_found')
    check(rr.runOpenUrl({ kind: 'openUrl', url: 'http://localhost:5173' }).ok && external.at(-1) === 'http://localhost:5173/', 'openUrl hands an http URL to openExternal')
    check(rr.runOpenUrl({ kind: 'openUrl', url: 'file:///C:/Windows/calc.exe' }).error === 'denied_url' && rr.runOpenUrl({ kind: 'openUrl', url: 'javascript:alert(1)' }).error === 'denied_url' && external.length === 1, 'openUrl refuses anything but http(s) and mailto with denied_url (contract R22-14)')
  }

  // ctl schemas.
  {
    const { parseRemoteClientMsg } = load('src/shared/remote-protocol-schemas.ts')
    const ctl = action => parseRemoteClientMsg(JSON.stringify({ v: 1, type: 'ctl', id: 'c1', action }))
    check(ctl({ kind: 'openPath', workspaceId: 'w', paneId: 'p', path: 'src/App.tsx:12' }) !== null, 'ctl openPath parses')
    check(ctl({ kind: 'openPath', workspaceId: 'w', path: 'a' }) === null && ctl({ kind: 'openPath', workspaceId: 'w', paneId: 'p', path: '' }) === null && ctl({ kind: 'openPath', workspaceId: 'w', paneId: 'p', path: 'x'.repeat(4097) }) === null, 'ctl openPath needs a pane and a 1..4096 path')
    check(ctl({ kind: 'openUrl', url: 'https://example.com' }) !== null && ctl({ kind: 'openUrl', url: 'javascript:alert(1)' }) !== null && ctl({ kind: 'openUrl', url: 'https://x.co/' + 'a'.repeat(2048) }) === null, 'ctl openUrl only bounds the length (<= 2048): the executor judges the scheme')
  }
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
  check(CONFIG_VERSION === 15, 'CONFIG_VERSION is 15 (R31-00)')
  const c = parseConfig(JSON.parse(JSON.stringify(v10)))
  check(c && c.version === 15, 'a v10 config parses and is stamped 15')
  const st = c.settings
  check(st.awakeMode === 'auto' && st.terminalUnicode11 === true && st.terminalAgentEndChip === true && st.notifications.inAppWhenFocused === true, 'v10 gains awakeMode, terminalUnicode11, terminalAgentEndChip and inAppWhenFocused defaults')
  check(JSON.stringify(st.agents) === JSON.stringify({ resumeOnStartup: 'ask', awakeDisplay: false, sidebarAgentRows: true, topicAsTitle: true, ctrlDigitFocus: true, resumeModalTimeoutSec: 60, resumeNudge: false, resumeNudgeText: '', sidebarSort: 'manual', cacheTimer: { enabled: false, ttlMinutes: 5 } }), 'v10 gains the settings.agents defaults (v11, v12 and v13 keys)')
  check(c.workspaces.every(w => w.agentsCollapsed === undefined && w.panes.every(p => p.lastSession === undefined)), 'agentsCollapsed and lastSession stay absent')
  const same = (a, b) => { if (a === b) return true; if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false; return Object.keys(a).every(k => k === 'version' || k === 'snippets' || same(a[k], b[k])) }
  check(same(v10, c), 'every v10 value survives the parse unchanged')
  check(c.snippets === undefined && c.quickCommands.length === 1 && c.quickCommands[0].id === 's1' && c.quickCommands[0].action === 'send', 'v10 snippets come back as quick commands (schema 12)')
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
  check(parseConfig({ ...v10, version: 16 }).version === 15, 'parse stamps the current version')

  // ConfigStore: only the renderer load (upgrade) stamps an older file, once.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-config-test-'))
  try {
    const app = { getPath: () => dir, isPackaged: false }
    const { ConfigStore } = load('src/main/store/ConfigStore.ts', { require: id => (id === 'electron' ? { app } : require(id)), process: { ...process, env: {}, argv: ['electron'] }, console: { ...console, warn() {} } })
    const file = path.join(dir, 'config.json'), raw = JSON.stringify(v10)
    fs.writeFileSync(file, raw)
    const store = new ConfigStore()
    check(store.load().version === 15 && fs.readFileSync(file, 'utf8') === raw, 'a plain load stays read-only (legacy verification safe)')
    check(store.load({ upgrade: true }).version === 15 && JSON.parse(fs.readFileSync(file, 'utf8')).version === 15, 'the renderer load leaves config.json on v15')
    check(fs.readFileSync(file + '.bak', 'utf8') === raw && fs.readdirSync(path.join(dir, 'backups')).length === 1, 'the pre-upgrade v10 file is kept as .bak and in backups/')
    const once = fs.readFileSync(file, 'utf8'); fs.writeFileSync(file + '.bak', 'marker')
    store.load({ upgrade: true })
    check(fs.readFileSync(file + '.bak', 'utf8') === 'marker' && fs.readFileSync(file, 'utf8') === once, 'an already current file is not rewritten')
    const newer = JSON.stringify({ ...v10, version: 16 }); fs.writeFileSync(file, newer)
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
    window: { snApi: { config: { save: cfg => saves.push(JSON.parse(JSON.stringify(cfg))) }, pty: { killPanes: async () => 0 } } },
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
  check(saves.length === 1 && saves[0].version === 15 && saves[0].activeWorkspaceId === 'w1', 'a persisted slice change writes once, stamped 15')
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

// ntfy channel, the away gate, the deep link and lastHost (E2-FR-40..42, 52; R22-18).
async function ntfyChannelChecks() {
  const { ntfyServer, NtfyNotifier, ntfyPayload } = load('src/main/status/NtfyNotifier.ts')
  check(ntfyServer('https://ntfy.sh') === 'https://ntfy.sh/' && ntfyServer(' https://push.example.com/ntfy?x=1#y ') === 'https://push.example.com/ntfy/', 'ntfyServer keeps https, drops query and fragment and ends on /')
  check(ntfyServer('http://192.168.1.10:8080') === 'http://192.168.1.10:8080/' && ntfyServer('http://100.80.1.2') === 'http://100.80.1.2/', 'plain http only for a private or tailnet IP')
  for (const bad of ['http://ntfy.sh', 'http://8.8.8.8', 'https://user:pass@ntfy.sh', 'ftp://ntfy.sh', 'not a url']) { assert.throws(() => ntfyServer(bad)); checks++ }
  const base = { ...settings.ntfy, enabled: true, topic: 'snaos-0123456789abcdef', token: 'tk_live', notifyAction: true, notifyDone: false }
  check(settings.ntfy.server === 'https://ntfy.sh' && settings.ntfy.enabled === false && settings.ntfy.notifyAction && !settings.ntfy.notifyDone, 'ntfy defaults: off, ntfy.sh, action on, done off')
  assert.throws(() => ntfyPayload({ ...base, topic: 'bad topic' }, { title: 't', message: 'm', urgent: true })); checks++
  const config = { settings: { language: 'es', notifications: settings }, workspaces: [{ id: 'w1', name: 'Front', panes: [{ id: 'p1', title: 'Builder' }] }] }
  const calls = []
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))
  {
    const notifier = new NtfyNotifier(async (url, init) => { calls.push({ url, init }); return new Response('{}', { status: 200 }) })
    notifier.setConfig(base)
    notifier.notify({ paneId: 'p1', provider: 'claude', state: 'action', reason: 'permission' }, config, 'http://100.64.0.2:4517/#ws=w1&pane=p1')
    await settle(); await settle()
    const body = JSON.parse(calls[0].init.body)
    check(calls.length === 1 && calls[0].url === 'https://ntfy.sh/' && calls[0].init.method === 'POST' && calls[0].init.redirect === 'error', 'an action publishes once with POST to the server root')
    check(calls[0].init.headers.Authorization === 'Bearer tk_live' && calls[0].init.headers['Content-Type'] === 'application/json', 'with the Bearer token and JSON')
    check(body.topic === base.topic && body.title === 'Claude: Permiso pendiente' && body.message === 'Front / Builder' && body.priority === 4 && body.tags[0] === 'warning' && body.click === 'http://100.64.0.2:4517/#ws=w1&pane=p1', 'body: topic, reason, workspace / console, priority 4, warning tag and the deep link')
    check(Object.keys(body).sort().join() === 'click,message,priority,tags,title,topic', 'nothing else rides along (never a reply preview)')
    notifier.notify({ paneId: 'p1', provider: 'claude', state: 'done' }, config)
    await settle()
    check(calls.length === 1, 'done is skipped while notifyDone is off')
    notifier.setConfig({ ...base, notifyDone: true, token: '' })
    notifier.notify({ paneId: 'p1', provider: 'codex', state: 'done' }, config)
    await settle(); await settle()
    const done = JSON.parse(calls[1].init.body)
    check(done.priority === 3 && done.tags[0] === 'white_check_mark' && done.title === 'Codex: Turno terminado' && !('click' in done) && !calls[1].init.headers.Authorization, 'done: priority 3, check tag, no click without a base, no token header without a token')
    check(notifier.health.lastSuccessAt !== null && notifier.health.error === null, 'health reports the last success')
    notifier.setConfig({ ...base, enabled: false })
    check(!notifier.wants({ paneId: 'p1', provider: 'claude', state: 'action' }), 'a disabled channel wants nothing')
    notifier.setConfig({ ...base, topic: '' })
    check(!notifier.wants({ paneId: 'p1', provider: 'claude', state: 'action' }), 'an empty topic wants nothing')
  }
  {
    let attempts = 0, delay = 0
    const notifier = new NtfyNotifier(async () => ++attempts === 1 ? new Response('', { status: 429, headers: { 'retry-after': '0.5' } }) : new Response('{}', { status: 200 }), async ms => { delay = ms })
    notifier.setConfig(base)
    check((await notifier.test()).ok && attempts === 2 && delay === 500, 'a 429 retries after Retry-After and the test reports Accepted')
  }
  {
    let attempts = 0
    const notifier = new NtfyNotifier(async () => { attempts++; return new Response('forbidden', { status: 403 }) })
    notifier.setConfig(base)
    const res = await notifier.test()
    check(!res.ok && res.error === 'ntfy HTTP 403' && attempts === 1, 'a 403 is not retried and the test reports the HTTP error')
    check(!res.error.includes(base.topic) && !res.error.includes(base.token), 'the error never echoes the topic or token')
  }
  {
    // Texts come from main/i18n.ts in the config language.
    const bodies = []
    let lang = 'es'
    const notifier = new NtfyNotifier(async (url, init) => { bodies.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }) }, async () => {}, () => ({ settings: { language: lang } }))
    notifier.setConfig(base)
    await notifier.test()
    lang = 'en'
    await notifier.test()
    notifier.notify({ paneId: 'p1', provider: 'claude', state: 'error' }, { ...config, settings: { ...config.settings, language: 'en' } })
    await settle(); await settle()
    check(bodies[0].message === 'Prueba de notificación de ntfy' && bodies[1].message === 'ntfy notification test', 'the test push follows the config language')
    check(bodies[2].title === 'Claude: Agent stopped with an error' && bodies[2].priority === 4, 'an English error notice reads "Agent stopped with an error"')
  }
  {
    let attempts = 0
    const notifier = new NtfyNotifier(async () => { attempts++; return new Response('', { status: attempts < 3 ? 502 : 200 }) }, async () => {})
    notifier.setConfig(base)
    check((await notifier.test()).ok && attempts === 3, '5xx retries within the bound')
    const none = new NtfyNotifier(async () => { throw new Error('no network') })
    check(!(await none.test(null)).ok, 'a test without a saved config fails cleanly')
    none.setConfig({ ...base, server: 'http://ntfy.sh' })
    check((await none.test()).error === 'Invalid ntfy server URL', 'an http public server is refused before any request')
  }

  {
    // Real fetch against a fake local ntfy server (loopback is a private host, so http is allowed).
    const got = []
    const server = require('node:http').createServer((req, res) => {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => { got.push({ method: req.method, url: req.url, auth: req.headers.authorization, type: req.headers['content-type'], body: JSON.parse(body) }); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"id":"x"}') })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const notifier = new NtfyNotifier()
      notifier.setConfig({ ...base, server: 'http://127.0.0.1:' + server.address().port })
      const res = await notifier.test()
      check(res.ok && got.length === 1 && got[0].method === 'POST' && got[0].url === '/' && got[0].auth === 'Bearer tk_live' && got[0].type === 'application/json' && got[0].body.topic === base.topic, 'a real publish reaches a local ntfy server: POST / with JSON and the token')
    } finally { server.close() }
  }

  const { isDesktopAway, AWAY_IDLE_THRESHOLD_SEC } = load('src/main/status/desktopAway.ts')
  let asked = 0
  const monitor = state => ({ getSystemIdleState: sec => { asked = sec; if (state === 'throw') throw new Error('x'); return state } })
  check(isDesktopAway(monitor('idle')) === true && asked === 180 && AWAY_IDLE_THRESHOLD_SEC === 180, 'idle is away, with the fixed 180s threshold')
  check(isDesktopAway(monitor('locked')) === true && isDesktopAway(monitor('active')) === false, 'locked is away, active is not')
  check(isDesktopAway(monitor('unknown')) === undefined && isDesktopAway(monitor('throw')) === undefined && isDesktopAway(null) === undefined, 'unknown, a throw or no monitor read as undefined')

  const { createNoticeRouter, deepLinkUrl } = load('src/main/status/noticeRouter.ts')
  check(deepLinkUrl('http://192.168.1.5:4517', 'w 1', 'p&1') === 'http://192.168.1.5:4517/#ws=w%201&pane=p%261' && deepLinkUrl(null, 'w', 'p') === undefined && deepLinkUrl('http://x:1', null, 'p') === undefined, 'deepLinkUrl encodes both ids and needs a base and a workspace')
  const routed = { discord: [], ntfy: [] }
  const env = { away: undefined, viewed: false, base: 'http://100.64.0.2:4517', onlyWhenAway: false, wants: true }
  const router = createNoticeRouter({
    discord: { notify: (n, c) => routed.discord.push({ n, c }) },
    ntfy: { notify: (n, c, click) => routed.ntfy.push({ n, click }), wants: () => env.wants },
    loadConfig: () => ({ ...config, settings: { ...config.settings, notifications: { ...settings, onlyWhenAway: env.onlyWhenAway } } }),
    isAway: () => { if (env.away === 'throw') throw new Error('x'); return env.away },
    isPaneViewed: () => env.viewed,
    deepLinkBase: () => env.base,
  })
  const notice = { paneId: 'p1', provider: 'claude', state: 'action', reason: 'question' }
  const count = () => routed.discord.length + '/' + routed.ntfy.length
  env.away = false; router.route(notice)
  check(count() === '1/1', 'with the gate off, an active PC still delivers to both')
  check(routed.ntfy[0].click === 'http://100.64.0.2:4517/#ws=w1&pane=p1', 'the ntfy click is the deep link of the pane workspace')
  env.onlyWhenAway = true; router.route(notice)
  check(count() === '1/1', 'gate on + active PC: neither Discord nor ntfy')
  env.away = true; router.route(notice)
  check(count() === '2/2', 'gate on + idle/locked: both deliver')
  env.away = undefined; router.route(notice)
  check(count() === '3/3', 'gate on + unknown state: delivers anyway')
  env.away = 'throw'; router.route(notice)
  check(count() === '4/4', 'gate on + a failing idle read: delivers anyway')
  env.viewed = true; router.route(notice)
  check(count() === '5/4', 'a pane watched on the phone skips ntfy only (Discord still goes)')
  env.viewed = false; env.base = null; router.route({ ...notice, paneId: 'gone' })
  check(count() === '6/5' && routed.ntfy.at(-1).click === undefined, 'no base (server off) or unknown pane: a push without click')
  env.wants = false; router.route(notice)
  check(count() === '7/5', 'ntfy not wanted: only Discord')

  // lastHost in remote-devices.json (E2-FR-42), under the dataDir() stub.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-lasthost-'))
  try {
    const electron = { app: { getPath: () => tmp, isPackaged: false } }
    const { DeviceRegistry } = load('src/main/remote/DeviceRegistry.ts', { require: id => id === 'electron' ? electron : require(id) })
    const file = path.join(tmp, 'remote-devices.json')
    fs.writeFileSync(file, JSON.stringify({ version: 1, devices: [{ id: 'old', name: 'Old', secret: 'ab', createdAt: 1, lastSeen: 1 }] }))
    const reg = new DeviceRegistry()
    check(reg.get('old') && reg.lastHosts().length === 0, 'a file written before lastHost still loads')
    const phone = reg.add('Phone')
    reg.setLastHost(phone.id, '192.168.1.5', 1000)
    check(JSON.parse(fs.readFileSync(file, 'utf8')).devices.find(d => d.id === phone.id).lastHost === '192.168.1.5', 'setLastHost persists a new host at once')
    fs.rmSync(file)
    reg.setLastHost(phone.id, '192.168.1.5', 2000)
    check(!fs.existsSync(file), 'the same host again does not write the file')
    reg.setLastHost('old', '100.64.0.7', 3000)
    check(fs.existsSync(file) && reg.lastHosts().map(h => h.host).join() === '100.64.0.7,192.168.1.5', 'a changed host persists and lastHosts lists the most recent first')
    check(!JSON.stringify(reg.listSanitized(new Set())).includes('lastHost'), 'the renderer list never carries lastHost')
    const again = new DeviceRegistry()
    check(again.get(phone.id).lastHost === '192.168.1.5' && again.get('old').lastHost === '100.64.0.7', 'lastHost survives a reload')
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
}

// R22-01: schema 12 notification keys (E2-FR-40/41) and the export sanitizer.
function ntfyConfigChecks() {
  check(JSON.stringify(settings.ntfy) === JSON.stringify({ enabled: false, server: 'https://ntfy.sh', topic: '', token: '', notifyAction: true, notifyDone: false }), 'ntfy defaults (off, ntfy.sh, action on, done off)')
  check(settings.onlyWhenAway === false, 'onlyWhenAway defaults to false')
  const junk = notificationSettingsSchema.parse({ ntfy: { enabled: 'yes', server: 'x'.repeat(600), topic: 'bad topic!', token: 't'.repeat(200), notifyDone: true }, onlyWhenAway: 'sometimes' })
  check(junk.ntfy.enabled === false && junk.ntfy.server === 'https://ntfy.sh' && junk.ntfy.topic === '' && junk.ntfy.token === '' && junk.ntfy.notifyDone === true && junk.onlyWhenAway === false, 'junk ntfy values fall back field by field')
  const kept = notificationSettingsSchema.parse({ ntfy: { enabled: true, topic: 'snaos-0123456789abcdef', token: 'tk_1' }, onlyWhenAway: true })
  check(kept.ntfy.enabled && kept.ntfy.topic === 'snaos-0123456789abcdef' && kept.ntfy.token === 'tk_1' && kept.onlyWhenAway === true, 'valid ntfy values are kept')
  const { sanitizeExport } = load('src/main/store/exportConfig.ts', { structuredClone })
  const cfg = { version: 12, workspaces: [], presets: [], snippets: [{ id: 's', name: 'S', text: 't' }], settings: { notifications: { ...settings, hooksEnabled: true, hookToken: 'a'.repeat(32), discord: { ...settings.discord, enabled: true, webhookUrl: 'https://discord.com/api/webhooks/1/x' }, ntfy: { ...settings.ntfy, enabled: true, topic: 'snaos-secret', token: 'tk_secret', notifyDone: true } } } }
  const out = sanitizeExport(cfg)
  const text = JSON.stringify(out)
  check(out.settings.notifications.ntfy.topic === '' && out.settings.notifications.ntfy.token === '' && out.settings.notifications.ntfy.enabled === false, 'the export blanks the ntfy topic and token and disables it')
  check(!text.includes('snaos-secret') && !text.includes('tk_secret') && !text.includes('webhooks') && !text.includes('a'.repeat(32)), 'no secret survives in the exported text')
  check(out.settings.notifications.ntfy.server === 'https://ntfy.sh' && out.settings.notifications.ntfy.notifyDone === true && !('snippets' in out), 'non-secret ntfy choices are kept, snippets never exported')
  check(cfg.settings.notifications.ntfy.topic === 'snaos-secret' && cfg.settings.notifications.discord.enabled === true, 'the live config is not mutated')
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
    const sessionEnds = []
    const manager = new StatusManager(() => ({ isDestroyed: () => false, isFocused: () => false, webContents: { send: (ch, e) => (ch === 'status:sessionEnd' ? sessionEnds : events).push(e) }, flashFrame() {} }), () => config, () => {}, reader)
    manager.setConfig(settings); manager.onSpawn('pty', 'pane')
    const heard = []
    const off = manager.addListener((e, cause) => { heard.push(e); causes.push(cause) })
    const hook = (name, rest = {}) => manager.onHookEvent({ consoleId: 'pane', ptyId: 'pty', sessionId: SID, name, ...rest })
    const flush = () => { while (timers.size) { const fns = [...timers.values()]; timers.clear(); fns.forEach(fn => fn()) } }
    return { manager, hook, events, sessionEnds, heard, causes, off, flush, tick: ms => { clock += ms }, last: () => events.at(-1) }
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
    check(h.sessionEnds.length === 1 && h.sessionEnds[0].reason === 'prompt_input_exit' && h.sessionEnds[0].cwd === process.cwd(), 'the SessionEnd also reaches the renderer as status:sessionEnd')
    const boom = rich(); boom.manager.addListener(() => { throw new Error('x') })
    const quiet = console.warn; console.warn = () => {}
    try { boom.hook('SessionStart') } finally { console.warn = quiet }
    check(boom.last().state === 'idle', 'a failing listener never breaks the renderer emission')
  }
  // status:sessionEnd allowlist (E6-FR-21).
  {
    const ends = (reason, rest = {}) => {
      const h = rich()
      h.hook('SessionStart')
      h.hook('SessionEnd', { endReason: reason, cwd: process.cwd(), ...rest })
      return h.sessionEnds
    }
    const exit = ends('prompt_input_exit')
    check(exit.length === 1 && exit[0].paneId === 'pane' && exit[0].ptyId === 'pty' && exit[0].provider === 'claude' && exit[0].sessionId === SID && exit[0].cwd === process.cwd() && typeof exit[0].at === 'number', 'prompt_input_exit emits the event with session id and cwd')
    check(ends('other').length === 1 && ends('other')[0].reason === 'other', 'other emits the event')
    check(['clear', 'logout', 'xyz', undefined].every(r => ends(r).length === 0), 'clear, logout, unknown and missing reasons emit nothing')
    check(ends('prompt_input_exit', { ptyId: 'old' }).length === 0, 'a stale ptyId emits nothing')
    check(ends('prompt_input_exit', { agentId: 'sub-1' }).length === 0, 'a subagent SessionEnd emits nothing')
    check(ends('prompt_input_exit', { sessionId: 'launch:abcdef12' }).length === 0 && ends('prompt_input_exit', { sessionId: 'x; rm -rf /' }).length === 0, 'an unsafe session id emits nothing')
    const noCwd = ends('prompt_input_exit', { cwd: undefined })
    check(noCwd.length === 1 && !('cwd' in noCwd[0]), 'without a hook cwd the event has no cwd')
  }
  // "Claude exited" chip commands (E6-FR-22/23): built only from validated parts.
  {
    const { agentEndCommands } = loadRenderer("export { agentEndCommands } from './agentEnd'")
    const UUID = '0b7c2f4e-1a2b-4c3d-8e9f-0123456789ab'
    const claude = { type: 'claude', command: 'claude', args: ['--model', 'opus'] }
    let c = agentEndCommands({ evt: { sessionId: UUID, cwd: 'C:\\repo' }, shellKind: 'powershell', preset: claude, initialCommand: 'claude --model opus' })
    check(c.resume === `Set-Location -LiteralPath 'C:\\repo'; claude --model opus --resume ${UUID}` && c.fresh === 'claude --model opus', 'PowerShell resume = Set-Location prefix + preset flags + --resume, New = the preset command')
    c = agentEndCommands({ evt: { sessionId: UUID, cwd: "C:\\it's" }, shellKind: 'powershell', preset: { type: 'shell', command: '', args: [] } })
    check(c.resume === `Set-Location -LiteralPath 'C:\\it''s'; claude --resume ${UUID}` && c.fresh === 'claude', 'a shell pane where claude was typed: bare claude, single quote doubled')
    c = agentEndCommands({ evt: { sessionId: UUID, cwd: 'C:\\Val\u2019s; calc; \u2018x' }, shellKind: 'powershell' })
    check(c.resume === `Set-Location -LiteralPath 'C:\\Val\u2019\u2019s; calc; \u2018\u2018x'; claude --resume ${UUID}`, 'PowerShell typographic quotes in the cwd are doubled too (they end a single-quoted string)')
    c = agentEndCommands({ evt: { sessionId: UUID, cwd: 'C:\\repo' }, shellKind: 'cmd' })
    check(c.resume === `cd /d "C:\\repo" && claude --resume ${UUID}`, 'cmd prefix')
    c = agentEndCommands({ evt: { sessionId: UUID, cwd: "/home/me/it's" }, shellKind: 'posix' })
    check(c.resume === `cd -- '/home/me/it'\\''s' && claude --resume ${UUID}`, 'posix prefix escapes the single quote')
    check(['x;y', 'has space', 'launch:abcdef12', '', 'a'.repeat(200)].every(id => agentEndCommands({ evt: { sessionId: id, cwd: '/tmp' }, shellKind: 'posix' }).resume === null), 'an unsafe session id leaves only [New]')
    check(['relative\\dir', 'C:\\a\u0007b', null].every(cwd => agentEndCommands({ evt: { sessionId: UUID, cwd: cwd ?? undefined }, shellKind: 'powershell' }).resume === `claude --resume ${UUID}`), 'a relative, control-char or missing cwd omits the prefix')
    check(agentEndCommands({ evt: { sessionId: UUID, cwd: 'C:\\100%' }, shellKind: 'cmd' }).resume === `claude --resume ${UUID}`, 'cmd rejects % in the cwd')
    check(agentEndCommands({ evt: { sessionId: UUID }, shellKind: null, paneCommand: 'npx claude' }).resume === null, 'a wrapper override cannot be resumed safely: only [New]')
    check(agentEndCommands({ evt: { sessionId: UUID }, shellKind: null, initialCommand: 'codex' }).fresh === 'claude', 'New types claude when the pane launches something else')
  }
  // When the chip's buttons enable (E6-FR-22): the first prompt mark after the
  // event with shell integration, else 800 ms; a lost mark falls back at 2500 ms.
  {
    let now = 10_000, seq = 0
    const timers = new Map()
    const sr = loadRenderer("export { notePrompt, forgetPrompts, hasPromptMarks, whenShellReady, whenPromptReturns, AGENT_END_PROMPT_CAP_MS, AGENT_END_OTHER_CAP_MS } from './shellReady'; export { AGENT_END_READY_MS } from './agentEnd'", {
      Date: { now: () => now },
      setTimeout: (fn, ms) => { timers.set(++seq, { fn, ms }); return seq }, clearTimeout: id => timers.delete(id),
    })
    const advance = ms => { now += ms; for (const [id, t] of [...timers]) { t.ms -= ms; if (t.ms <= 0) { timers.delete(id); t.fn() } } }
    check(sr.AGENT_END_READY_MS === 800 && sr.AGENT_END_PROMPT_CAP_MS === 2500, '800 ms without integration, 2500 ms cap with it (the FR-30 cap)')
    let fired = 0
    sr.whenShellReady('plain', now, () => fired++)
    advance(799)
    check(fired === 0 && !sr.hasPromptMarks('plain'), 'without integration nothing is ready before 800 ms')
    advance(1)
    check(fired === 1, 'without integration it is ready at 800 ms')
    fired = 0
    sr.whenShellReady('plain', now - 5000, () => fired++)
    check(fired === 1 && timers.size === 0, 'an old event is ready at once')

    sr.notePrompt('ps')
    check(sr.hasPromptMarks('ps'), 'a prompt mark turns integration on for that pane')
    advance(3000)
    fired = 0
    const evtAt = now
    sr.whenShellReady('ps', evtAt, () => fired++)
    advance(1500)
    check(fired === 0, 'with integration 800 ms are not enough: it waits for the prompt mark')
    sr.notePrompt('ps')
    check(fired === 1 && timers.size === 0, 'the first prompt mark after the event makes it ready and drops the cap timer')
    sr.notePrompt('ps')
    check(fired === 1, 'later prompt marks fire nothing more')
    fired = 0
    sr.whenShellReady('ps', evtAt, () => fired++)
    check(fired === 1, 'a prompt mark that already came after the event is ready at once')

    advance(100)
    fired = 0
    sr.whenShellReady('ps', now, () => fired++)
    advance(2499)
    check(fired === 0, 'a lost prompt mark waits up to the cap')
    advance(1)
    check(fired === 1, 'and falls back at 2500 ms')
    sr.notePrompt('ps')
    check(fired === 1, 'a late mark after the fallback fires nothing')

    advance(10)
    fired = 0
    const cancel = sr.whenShellReady('ps', now, () => fired++)
    cancel()
    sr.notePrompt('ps'); advance(3000)
    check(fired === 0 && timers.size === 0, 'a cancelled wait never fires')

    sr.forgetPrompts('ps')
    fired = 0
    sr.whenShellReady('ps', now, () => fired++)
    advance(800)
    check(!sr.hasPromptMarks('ps') && fired === 1, 'a forgotten pane (new shell, unmount) is back on the 800 ms timer')

    // v2.2: a SessionEnd `other` offers the chip only when the prompt comes back.
    sr.notePrompt('drv')
    advance(10)
    let back = 0
    sr.whenPromptReturns('drv', now, sr.AGENT_END_OTHER_CAP_MS, () => back++)
    advance(sr.AGENT_END_OTHER_CAP_MS + 10)
    check(back === 0 && timers.size === 0, 'no prompt within the cap: never (a driver script keeps running)')
    sr.notePrompt('drv')
    check(back === 0, 'a mark after the cap fires nothing')
    advance(10)
    sr.whenPromptReturns('drv', now, sr.AGENT_END_OTHER_CAP_MS, () => back++)
    advance(500); sr.notePrompt('drv')
    check(back === 1 && timers.size === 0, 'the prompt coming back within the cap offers it')
    sr.whenPromptReturns('drv', now - 600, 3000, () => back++)
    check(back === 2, 'a prompt already back after the event offers it at once')
    sr.whenPromptReturns('none', now, 3000, () => back++)
    advance(4000)
    check(back === 2, 'a pane without marks never fires (callers check hasPromptMarks)')
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
    window: { snApi: { config: { save: cfg => saves.push(JSON.parse(JSON.stringify(cfg))) }, pty: { killPanes: async () => 0 } } },
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
  // "Claude exited" chip and "exited" label are transient and never persist (E6-FR-22/38).
  const savesBefore = saves.length
  const endEvt = { paneId: 'p1', ptyId: 'pty', provider: 'claude', sessionId: SID, reason: 'prompt_input_exit', at: 1 }
  S.getState().setAgentEnded(endEvt)
  S.getState().setPaneStatus({ paneId: 'p1', state: 'idle', precise: true, notify: false, provider: 'claude', updatedAt: 20, sessionId: SID })
  check(S.getState().agentEnded.p1 === endEvt, 'the end status of the same session keeps the chip')
  S.getState().setPaneStatus({ paneId: 'p1', state: 'idle', precise: true, notify: false, provider: 'claude', updatedAt: 21, sessionId: '1c8d3a5f-2b3c-4d4e-9fa0-123456789abc' })
  check(S.getState().agentEnded.p1 === undefined, 'a new session hides the chip')
  S.getState().setAgentEnded(endEvt)
  S.getState().setPaneStatus({ paneId: 'p1', state: 'working', precise: false, notify: false, provider: 'claude', updatedAt: 22 })
  check(S.getState().agentEnded.p1 === undefined, 'Claude working again hides the chip')
  S.getState().setAgentEnded(endEvt)
  S.getState().clearAgentEnded('p1')
  const unchanged = S.getState().agentEnded
  S.getState().clearAgentEnded('p1')
  check(S.getState().agentEnded.p1 === undefined && S.getState().agentEnded === unchanged, 'clearAgentEnded hides it and is a no-op when clean')
  S.getState().setPaneExit('p1', 3)
  const exitRef = S.getState().paneExit
  S.getState().setPaneExit('p1', 3)
  check(S.getState().paneExit.p1 === 3 && S.getState().paneExit === exitRef, 'setPaneExit records the code, same reference on repeat')
  S.getState().setAgentEnded(endEvt)
  S.getState().removePane('w1', 'p1')
  check(S.getState().paneExit.p1 === undefined && S.getState().agentEnded.p1 === undefined, 'removing the pane drops its exit and chip')
  flushSaves()
  check(saves.slice(savesBefore).every(c => !('paneExit' in c) && !('agentEnded' in c)), 'neither reaches the config file')
  stop()

  // restartPane: in place when the terminal registered a restarter, else remount (E6-FR-18).
  {
    const rr = loadRenderer(`export { useAppStore } from './store'; export * from './restartRegistry'`, { window: { snApi: { pty: { killPanes: async () => 0 } } }, document: { hasFocus: () => false } })
    const st = rr.useAppStore.getState()
    let inPlace = 0
    const fn = () => { inPlace++ }
    rr.registerRestarter('p9', fn)
    st.restartPane('p9')
    check(inPlace === 1 && rr.useAppStore.getState().paneEpoch.p9 === undefined, 'a mounted terminal restarts in place, no remount')
    st.restartPaneClean('p9')
    check(inPlace === 1 && rr.useAppStore.getState().paneEpoch.p9 === 1, 'Restart clean always remounts')
    rr.unregisterRestarter('p9', () => {})
    st.restartPane('p9')
    check(inPlace === 2, 'unregister only drops the restarter it registered')
    rr.unregisterRestarter('p9', fn)
    st.restartPane('p9')
    check(inPlace === 2 && rr.useAppStore.getState().paneEpoch.p9 === 2, 'without a mounted terminal restartPane remounts')
  }
}

// R22-17 (E2-FR-38/39): firewall inspection parser on canned JSON, the
// elevated fix script and its wrapper (built, never executed), the service
// cache / fix flow with a fake PowerShell runner; E2-FR-35: connLog.redact.
async function firewallChecks() {
  const fw = load('src/main/remote/firewall.ts')
  const decode = (args) => Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le')
  const EXE = 'C:\\Users\\u\\AppData\\Local\\Programs\\SnAgentsOS\\SnAgentsOS.exe'
  const { LEGACY_BRAND } = load('src/shared/brand.ts')
  const OLD = `c:\\users\\u\\appdata\\local\\programs\\${LEGACY_BRAND.packageName}\\${LEGACY_BRAND.winExe.toLowerCase()}`
  check(fw.psQuote("O'Brien") === "'O''Brien'" && fw.psQuote('a\u2019b') === "'a\u2019\u2019b'", 'psQuote doubles ASCII and typographic single quotes')
  const sample = "Write-Output 'á'"
  check(decode(fw.psArgs(sample)) === sample && fw.psArgs(sample).slice(0, 2).join() === '-NoProfile,-NonInteractive', 'psArgs: -NoProfile -NonInteractive -EncodedCommand of UTF-16LE base64')
  const insp = fw.buildInspectScript({ exe: EXE, port: 4517, ips: ['192.168.1.20', "1.2.3.4'; Remove-Item C:\\ #", '100.70.1.2'] })
  check(insp.includes('$port = 4517') && insp.includes(`$exe = '${EXE}'`) && insp.includes(`$legacy = '${LEGACY_BRAND.winExe}'`), 'inspection script carries port, exe and the legacy exe name')
  check(insp.includes("$ips = @('192.168.1.20', '100.70.1.2')") && !insp.includes('Remove-Item'), 'only IPv4 literals reach the inspection script')
  check(insp.includes('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8') && insp.includes('ConvertTo-Json'), 'UTF-8 output and JSON result')
  check(!/Remove-NetFirewallRule|New-NetFirewallRule|Set-NetFirewall/.test(insp), 'the inspection script is read-only')
  assert.throws(() => fw.buildInspectScript({ exe: EXE, port: 0, ips: [] })); checks++
  const fix = fw.buildFixScript({ exe: EXE, port: 4517, programScope: true, tailnet: false, domain: false })
  check(fix.includes(`-Program '${EXE}'`) && fix.includes("-Name 'SnAgentsOS.Remote.TCP'") && fix.includes('-LocalPort 4517 -Profile Private -RemoteAddress LocalSubnet') && fix.includes('-EdgeTraversalPolicy Block'), 'installed fix: Allow by program and port on Private / LocalSubnet')
  check(fix.indexOf("Get-NetFirewallRule -Name 'SnAgentsOS.Remote.TCP' -ErrorAction SilentlyContinue | Remove-NetFirewallRule") < fix.indexOf("New-NetFirewallRule -Name 'SnAgentsOS.Remote.TCP'"), 'our rule is removed before it is recreated (running twice never duplicates)')
  check(fix.includes("[string]$r.Action -ne 'Block'") && fix.includes("$prof -notmatch 'Private'") && fix.includes("$lp -contains 'Any' -or $lp -contains $port") && fix.includes('-ieq $exe'), 'only Block rules on the current exe (TCP/Any, Private/Any, port/Any) are removed')
  check(!fix.includes("New-NetFirewallRule -Name 'SnAgentsOS.Remote.Tailnet'"), 'no Tailscale rule without a Tailscale endpoint')
  const portable = fw.buildFixScript({ exe: EXE, port: 4600, programScope: false, tailnet: true, domain: true })
  check(!portable.includes('-Program') && portable.includes('-LocalPort 4600 -Profile Private,Domain'), 'portable / dev fix: port-only rule, Domain added for a domain network')
  check(portable.includes("New-NetFirewallRule -Name 'SnAgentsOS.Remote.Tailnet'") && portable.includes('-Profile Any -RemoteAddress 100.64.0.0/10'), 'the Tailscale rule is limited to 100.64.0.0/10 on any profile')
  check(fix.includes("$prof -notmatch 'Private')") && portable.includes("$prof -notmatch 'Private|Domain|Public')"), 'Public Blocks on the exe are removed only when the Tailscale rule is made (Domain on a domain network)')
  const wrap = fw.buildElevatedWrapper(fix)
  check(wrap.includes('-Verb RunAs -Wait -PassThru') && wrap.includes('NativeErrorCode -eq 1223') && wrap.includes("Join-Path $PSHOME 'powershell.exe'"), 'the wrapper elevates, waits and maps a cancelled UAC to 1223')
  const innerB64 = /'-EncodedCommand', '([A-Za-z0-9+/=]+)'/.exec(wrap)[1]
  check(Buffer.from(innerB64, 'base64').toString('utf16le') === fix, 'the wrapper carries the fix script verbatim')

  const endpoints = [{ ip: '192.168.1.20', kind: 'lan', url: '' }, { ip: '100.70.1.2', kind: 'tailscale', url: '' }]
  const ctx = { exe: EXE, port: 4517, programScope: true, endpoints, now: 5 }
  const ep = (profile, tsProfile = 'Private', name = 'Casa') => [{ ip: '192.168.1.20', profile, name, alias: 'Wi-Fi' }, { ip: '100.70.1.2', profile: tsProfile, name: 'Tailscale', alias: 'Tailscale' }]
  const rule = (o) => ({ name: 'r', displayName: 'r', action: 'Allow', program: 'Any', protocol: 'TCP', localPort: ['4517'], profile: 'Private', interfaces: ['Any'], localAddress: ['Any'], ...o })
  const allowExe = rule({ name: 'mine', program: EXE.toLowerCase(), localPort: ['Any'] })
  const tailAllow = rule({ name: 'tail', profile: 'Any', program: EXE })
  const parse = (endpointsRaw, rules, c = ctx) => fw.parseInspectOutput(JSON.stringify({ endpoints: endpointsRaw, rules }), c)
  let st = parse(ep('Private'), [allowExe, tailAllow])
  check(st.state === 'ok' && st.ok && st.ruleFound && st.profile === 'Private' && st.endpoints[0].networkName === 'Casa', 'Private network + Allow on the exe (any case) = OK')
  st = parse(ep('Public'), [allowExe, rule({ profile: 'Any', program: EXE })])
  check(st.state === 'publicProfile' && st.profile === 'Public' && !st.ok, 'a Public LAN is the amber publicProfile state')
  st = parse(ep('Private'), [rule({ program: OLD, localPort: ['Any'], profile: 'Any' })])
  check(st.state === 'noRule' && !st.ruleFound, 'an Allow on the exe from before the rebrand does not count')
  const defenderBlock = rule({ name: 'TCP Query User{X}', displayName: 'snagentsos.exe', action: 'Block', program: EXE.toLowerCase(), localPort: ['Any'], profile: 'Private' })
  st = parse(ep('Private'), [allowExe, tailAllow, defenderBlock])
  check(st.state === 'blocked' && st.fixable && st.blockingRules[0].scope === 'currentProgram', 'a Defender Block on the installed exe is blocked and fixable')
  st = parse(ep('Private'), [allowExe, tailAllow, rule({ action: 'Block', program: OLD, localPort: ['Any'], profile: 'Any' })])
  check(st.state === 'ok' && st.blockingRules.length === 0, 'Blocks on the 1.x exe are inert and ignored')
  st = parse(ep('Private'), [allowExe, tailAllow, rule({ name: 'port-block', displayName: 'Corp block', action: 'Block', profile: 'Any' })])
  check(st.state === 'blocked' && !st.fixable && st.blockingRules[0].scope === 'port', 'a port Block is blocked and never fixable')
  st = parse(ep('Private'), [allowExe, tailAllow, rule({ action: 'Block', program: 'C:\\Users\\u\\AppData\\Local\\Temp\\old\\SnAgentsOS.exe', profile: 'Any', localPort: ['Any'] })])
  check(st.state === 'ok' && st.blockingRules[0].scope === 'otherProgram' && st.fixable, 'a Block on another copy of the exe is listed but does not block this one')
  st = parse(ep('Private'), [allowExe, tailAllow, rule({ action: 'Block', program: EXE, profile: 'Public', localPort: ['Any'] })])
  check(st.state === 'ok', 'a Public-only Block does not apply on a Private network')
  st = parse(ep('Private', 'Public'), [allowExe, tailAllow, rule({ name: 'pub', action: 'Block', program: EXE, profile: 'Public', localPort: ['Any'] })])
  check(st.state === 'blocked' && st.fixable && st.blockingRules[0].scope === 'currentProgram', 'a Public Block on the exe blocks a Public Tailscale endpoint and is fixable')
  st = parse(ep('Public'), [allowExe, tailAllow, rule({ action: 'Block', program: EXE, profile: 'Public, Private', localPort: ['Any'] })])
  check(st.state === 'publicProfile' && st.fixable, 'a Public LAN comes before a Block on our exe (mark the network Private first)')
  st = parse(ep('Public'), [allowExe, tailAllow, rule({ name: 'corp', action: 'Block', profile: 'Any' })])
  check(st.state === 'blocked' && !st.fixable, 'a port Block still wins over a Public LAN')
  st = parse(ep('Private'), [rule({ name: 'Tailscale-In', protocol: 'Any', localPort: ['Any'], profile: 'Domain, Private', localAddress: ['100.70.1.2'] })])
  check(st.state === 'noRule' && st.ruleFound, 'an Allow bound to the Tailscale address leaves the LAN uncovered')
  st = parse(ep('Private'), [rule({ protocol: 'UDP', localPort: ['Any'], profile: 'Any' })])
  check(!st.ruleFound && st.state === 'noRule', 'a UDP Allow does not count')
  st = parse(ep('Private'), [rule({ localPort: ['4000-5000'], profile: 'Any' })])
  check(st.state === 'ok', 'a port range covering the port counts')
  st = parse(ep('Private'), [rule({ localPort: ['4518'], profile: 'Any' })])
  check(!st.ruleFound, 'another port does not count')
  st = parse([...ep('Private'), { ip: '172.20.0.1', profile: 'Public', name: 'Unidentified', alias: 'vEthernet (WSL)' }], [allowExe, tailAllow])
  check(st.state === 'ok' && st.endpoints.length === 3, 'a Public vEthernet adapter does not make the state amber')
  st = fw.parseInspectOutput(JSON.stringify({ endpoints: { ip: '192.168.1.20', profile: 'Private', name: 'Casa', alias: 'Wi-Fi' }, rules: { name: 'one', displayName: 'one', action: 'Allow', program: EXE, protocol: 'TCP', localPort: '4517', profile: 'Private', interfaces: 'Any', localAddress: 'Any' } }), { ...ctx, endpoints: [endpoints[0]] })
  check(st.state === 'ok' && st.endpoints.length === 1, 'single-element arrays collapsed by ConvertTo-Json still parse')
  st = fw.parseInspectOutput('WARNING: noise\r\n' + JSON.stringify({ endpoints: ep('DomainAuthenticated', 'DomainAuthenticated'), rules: [rule({ profile: 'Domain', program: EXE, localPort: ['Any'] })] }), ctx)
  check(st.state === 'ok' && st.profile === 'DomainAuthenticated', 'leading noise is skipped; Domain profile rules cover a domain network')
  assert.throws(() => fw.parseInspectOutput('Acceso denegado', ctx)); checks++
  check(fw.localAddressCovers(['192.168.1.0/24'], '192.168.1.20') && !fw.localAddressCovers(['192.168.2.0/255.255.255.0'], '192.168.1.20') && fw.localAddressCovers(['192.168.1.10-192.168.1.30'], '192.168.1.20') && !fw.localAddressCovers(['fd7a::1'], '192.168.1.20'), 'localAddressCovers: CIDR, mask, range, IPv6')

  // Service: cache, unknown, unsupported, fix flow.
  let clock = 1000, runs = [], next = []
  const okJson = JSON.stringify({ endpoints: ep('Private'), rules: [allowExe, tailAllow] })
  const blockedJson = JSON.stringify({ endpoints: ep('Private'), rules: [allowExe, tailAllow, defenderBlock] })
  const svc = (over = {}) => new fw.FirewallService({ platform: 'win32', exe: () => EXE, port: () => 4517, programScope: () => true, endpoints: () => endpoints, now: () => clock, run: async (args, timeout) => { runs.push({ script: decode(args), timeout }); return next.shift() ?? { code: 0, stdout: okJson, timedOut: false } }, ...over })
  const s1 = svc()
  st = await s1.check()
  check(st.state === 'ok' && runs.length === 1 && runs[0].timeout === 10000, 'check runs the inspection with a 10s timeout')
  await s1.check(); clock += 59000; await s1.check()
  check(runs.length === 1, 'the result is cached for 60s')
  await s1.check(true); check(runs.length === 2, 'force skips the cache')
  clock += 61000; await s1.check(); check(runs.length === 3, 'the cache expires after 60s')
  const both = await Promise.all([s1.check(true), s1.check(true)])
  check(runs.length === 4 && both[0] === both[1], 'concurrent checks share one PowerShell run')
  next.push({ code: null, stdout: '', timedOut: true })
  st = await s1.check(true)
  check(st.state === 'unknown' && st.detail === 'timeout', 'a timed out check is unknown (grey)')
  await s1.check(); check(runs.length === 6, 'an unknown result is not cached')
  st = await svc({ platform: 'darwin' }).check()
  check(st.state === 'unsupported' && runs.length === 6, 'off Windows nothing runs')
  runs = []; next = [{ code: 0, stdout: blockedJson, timedOut: false }, { code: 1223, stdout: '', timedOut: false }, { code: 0, stdout: blockedJson, timedOut: false }]
  // A forced check started after a fix never reuses a run from before it.
  {
    let release
    const gate = new Promise(r => { release = r })
    let n = 0
    const s3 = svc({ run: async (args) => { const script = decode(args); n++; if (n === 1) { await gate; return { code: 0, stdout: blockedJson, timedOut: false } } if (script.includes('-Verb RunAs')) return { code: 0, stdout: '', timedOut: false }; return { code: 0, stdout: okJson, timedOut: false } } })
    const stale = s3.check()
    const fixed = s3.fix()
    await new Promise(r => setTimeout(r, 0))
    release()
    const [a, b] = await Promise.all([stale, fixed])
    check(a.state === 'blocked' && b.ok && b.status.state === 'ok', 'the re-check after a fix is a fresh run, not one that started before it')
  }
  const s2 = svc(); await s2.check()
  let res = await s2.fix()
  check(res.cancelled && res.error === 'cancelled' && !res.ok && res.status.state === 'blocked', 'a cancelled UAC is reported as Cancelled')
  check(runs[1].script.includes('-Verb RunAs') && runs[1].timeout === 180000 && runs.length === 3, 'the fix runs the elevated wrapper and re-checks')
  next = [{ code: 0, stdout: '', timedOut: false }, { code: 0, stdout: okJson, timedOut: false }]
  res = await s2.fix()
  check(res.ok && res.status.state === 'ok', 'an accepted fix re-checks to OK')
  next = [{ code: 0, stdout: '', timedOut: false }, { code: 0, stdout: JSON.stringify({ endpoints: ep('Private'), rules: [allowExe, tailAllow, rule({ name: 'corp', action: 'Block', profile: 'Any' })] }), timedOut: false }]
  res = await s2.fix()
  check(!res.ok && res.error === 'notFixed' && res.status.fixable === false, 'a port Block left behind is "could not fix", never OK')
  const fixRuns = runs.filter(r => r.script.includes('-Verb RunAs')).map(r => Buffer.from(/'-EncodedCommand', '([A-Za-z0-9+/=]+)'/.exec(r.script)[1], 'base64').toString('utf16le'))
  check(fixRuns.length === 3 && fixRuns.every(s => s === fixRuns[0]) && fixRuns[0].includes('-Program') && fixRuns[0].includes("New-NetFirewallRule -Name 'SnAgentsOS.Remote.Tailnet'"), 'every fix run builds the same idempotent script (installed: by program, plus the Tailscale rule)')
  runs = []
  await svc({ programScope: () => false }).fix()
  const portableInner = Buffer.from(/'-EncodedCommand', '([A-Za-z0-9+/=]+)'/.exec(runs[0].script)[1], 'base64').toString('utf16le')
  check(!portableInner.includes('-Program'), 'the portable fix creates a port-only rule')
  check((await svc({ platform: 'linux' }).fix()).error === 'unsupported', 'fix off Windows is unsupported')
}

function connLogRedactChecks() {
  const { redact } = load('src/mobile/src/lib/connLog.ts')
  const secret = '0f'.repeat(32)
  const line = `auth secret=${secret} hmac=${'a1'.repeat(32)} {"proof":"beef","nonce":"cafe","clientNonce":"d00d","token":"t0k"}`
  const out = redact(line)
  check(!out.includes(secret) && !out.includes('beef') && !out.includes('cafe') && !out.includes('d00d') && !out.includes('t0k'), 'connLog.redact removes secret, hmac, proof, nonce, clientNonce and token values')
  check(!redact('pair sent code=AB12CD34').includes('AB12CD34') && !redact('pairCode=AB12CD34').includes('AB12CD34') && !redact('open http://x/#pair=AB12CD34').includes('AB12CD34'), 'connLog.redact removes the pairing code (code= on pair lines, pairCode=, #pair=)')
  check(redact('close=1006 clean=false dur=1234') === 'close=1006 clean=false dur=1234' && redact('err code=version') === 'err code=version', 'connLog.redact keeps close lines and code= outside pair lines')
  check(redact('dial 192.168.1.20:4517') === 'dial 192.168.1.20:4517', 'connLog.redact keeps the dialed IP')
}

main().catch(error => { console.error(error); process.exitCode = 1 })

// R22-15 (E2-FR-20, 21, 48): input invalidation of answer cards in
// StatusManager (reports never count, a letter does, state untouched),
// PtyManager.write notifying it, and buildAskAnswerKeys / sanitizeAskFreeText.
function promptCardChecks() {
  const SID = '0123abcd-0000-4000-8000-000000000000'
  function track(start = 1000) {
    const events = []
    let clock = start
    class FakeDate extends Date { static now() { return clock } }
    const { StatusManager } = load('src/main/status/StatusManager.ts', {
      require: id => id === 'electron' ? { Notification: { isSupported: () => false } } : require(id),
      setTimeout: () => 0, clearTimeout() {}, Date: FakeDate,
    })
    const manager = new StatusManager(() => ({ isDestroyed: () => false, isFocused: () => false, webContents: { send: (ch, e) => { if (ch !== 'status:sessionEnd') events.push(e) } }, flashFrame() {} }), () => null, () => {})
    manager.setConfig(settings); manager.onSpawn('pty', 'pane')
    const hook = (name, rest = {}) => manager.onHookEvent({ consoleId: 'pane', ptyId: 'pty', sessionId: SID, name, ...rest })
    const input = (data, ptyId = 'pty') => manager.onUserInput(ptyId, 'pane', data)
    return { manager, hook, input, events, tick: ms => { clock += ms }, last: () => events.at(-1) }
  }
  {
    const h = track()
    h.hook('UserPromptSubmit', { prompt: 'x' }); h.tick(5)
    h.hook('PermissionRequest', { toolUseId: 'p1', toolName: 'Bash', toolSummary: 'Bash: npm test', requestSummary: 'npm test' })
    check(h.last().pending?.[0]?.id === 'p1', 'a permission is listed in pending[]')
    const n = h.events.length
    h.tick(5)
    for (const report of ['\x1b[I', '\x1b[O', '\x1b[<0;10;5M', '\x1b[<0;10;5m', '\x1b[M !!', '\x1b[I\x1b[O', '\x1b[12;40R', '\x1b[?62;22c', '\x1b[0n', '\x1b]11;rgb:0000/0000/0000\x1b\\', '\x1b]10;rgb:ffff/ffff/ffff\x07']) h.input(report)
    check(h.events.length === n && h.manager.stateOf('pane').pending?.[0]?.id === 'p1', 'focus, mouse and terminal reports never invalidate the card')
    h.input('a', 'other-pty')
    check(h.events.length === n && h.manager.stateOf('pane').pending?.length === 1, 'input of a stale pty is ignored')
    h.input('a')
    const after = h.last()
    check(h.events.length === n + 1 && after.pending === undefined, 'a letter takes the request out of pending[] at once')
    check(after.state === 'action' && after.reason === 'permission' && after.pendingCount === 1, 'state, reason and pendingCount stay until the hook resolves it')
    h.input('\r')
    check(h.events.length === n + 1, 'more input after the invalidation emits nothing new')
    h.hook('PostToolUse', { toolUseId: 'p1' })
    check(h.last().state === 'working' && h.last().pendingCount === 0, 'PostToolUse still resolves the invalidated request')
    h.tick(5); h.input('z'); h.tick(5)
    h.hook('PermissionRequest', { toolUseId: 'p2', toolName: 'Read', requestSummary: 'a.ts' })
    check(h.last().pending?.[0]?.id === 'p2', 'input before a request never invalidates it')
    h.input('\x1b')
    check(h.last().pending === undefined && h.last().state === 'action', 'Esc (a deny) invalidates the card too')
    h.hook('PostToolUse', { toolUseId: 'p2' })
    // More terminal replies (DECXCPR, DECRQSS) never invalidate either.
    h.tick(5)
    h.hook('PermissionRequest', { toolUseId: 'p2b', toolName: 'Bash', requestSummary: 'ls' })
    h.tick(1)
    h.input('\x1b[?12;40;1R'); h.input('\x1bP1$r0;1m\x1b\\'); h.input('\x1bP0$r\x1b\\')
    check(h.last().pending?.[0]?.id === 'p2b', 'DECXCPR and DECRQSS replies never invalidate the card')
    h.hook('PostToolUse', { toolUseId: 'p2b' })
    // A fallback (Notification only) answered before its PermissionRequest
    // arrives: the promoted request keeps the mark, so no card comes back.
    h.tick(5)
    h.hook('Notification', { notificationType: 'permission_prompt' })
    check(h.last().pending?.[0]?.id === 'fallback:permission', 'a permission_prompt Notification lists the fallback')
    h.tick(1); h.input('1')
    check(h.last().pending === undefined, 'answering the fallback invalidates it')
    h.tick(1)
    h.hook('PermissionRequest', { toolUseId: 'p2c', toolName: 'Bash', requestSummary: 'ls' })
    check(h.manager.stateOf('pane').pending === undefined && h.manager.stateOf('pane').pendingCount === 1, 'the promoted request of an answered fallback stays out of pending[]')
    h.hook('PostToolUse', { toolUseId: 'p2c' })
    h.tick(5)
    h.hook('Notification', { notificationType: 'permission_prompt' })
    h.tick(1)
    h.hook('PermissionRequest', { toolUseId: 'p2d', toolName: 'Bash', requestSummary: 'ls' })
    check(h.manager.stateOf('pane').pending?.[0]?.id === 'p2d', 'an unanswered fallback promotes to a visible request')
    h.hook('PostToolUse', { toolUseId: 'p2d' })
  }
  {
    const h = track()
    h.hook('UserPromptSubmit', { prompt: 'x' })
    h.hook('PreToolUse', { toolName: 'AskUserQuestion', toolUseId: 'q1', question: 'Cual?', questions: [{ question: 'Cual?', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }] })
    h.tick(1); h.input('1')
    check(h.last().pending === undefined && h.last().state === 'action' && h.last().reason === 'question', 'a question answered on the desktop leaves action / question without its card')
    // end clears the request with its marks: a new session lists a fresh one.
    h.hook('SessionEnd', { endReason: 'other' })
    h.hook('SessionStart'); h.hook('UserPromptSubmit', { prompt: 'y' }); h.tick(1)
    h.hook('PermissionRequest', { toolUseId: 'p3', toolName: 'Bash' })
    check(h.last().pending?.[0]?.id === 'p3', 'after SessionEnd a new request starts visible')
    // clearPane (pty exit) and a new spawn: nothing carries over.
    h.tick(1); h.input('y')
    h.manager.onExit('pty', 'pane'); h.manager.onSpawn('pty2', 'pane')
    h.manager.onHookEvent({ consoleId: 'pane', ptyId: 'pty2', sessionId: SID, name: 'SessionStart' })
    h.manager.onHookEvent({ consoleId: 'pane', ptyId: 'pty2', sessionId: SID, name: 'PermissionRequest', toolUseId: 'p4', toolName: 'Bash' })
    check(h.last().pending?.[0]?.id === 'p4', 'after clearPane and a respawn a new request starts visible')
    h.manager.onUserInput('pty', 'pane', 'a')
    check(h.last().pending?.[0]?.id === 'p4', 'input of the old pty never touches the new one')
    // Two requests: one input invalidates both; a later one stays visible.
    h.manager.onHookEvent({ consoleId: 'pane', ptyId: 'pty2', sessionId: SID, name: 'PermissionRequest', toolUseId: 'p5', toolName: 'Edit' })
    h.tick(1); h.manager.onUserInput('pty2', 'pane', 'n')
    check(h.last().pending === undefined && h.last().pendingCount === 2, 'one input invalidates every earlier request of the pane')
    h.tick(1)
    h.manager.onHookEvent({ consoleId: 'pane', ptyId: 'pty2', sessionId: SID, name: 'PermissionRequest', toolUseId: 'p6', toolName: 'Write' })
    check(h.last().pending?.length === 1 && h.last().pending[0].id === 'p6' && h.last().pendingCount === 3, 'a request after the input is listed alone')
  }
  // PtyManager.write notifies the sinks that implement onUserInput, before writing.
  {
    const writes = [], order = []
    const impl = (_shell, _args, opts) => ({ cols: opts.cols, rows: opts.rows, onData() {}, onExit() {}, write: d => { writes.push(d); order.push('pty') }, resize() {}, pause() {}, resume() {}, kill() {} })
    const code = buildSync({ entryPoints: [path.join(root, 'src/main/pty/PtyManager.ts')], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'node-pty', '@xterm/headless', '@xterm/addon-serialize', '@xterm/addon-unicode11'], alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
    const mod = { exports: {} }
    vm.runInNewContext(code, { module: mod, exports: mod.exports, Buffer, process, setTimeout, clearTimeout, setInterval, clearInterval, console: { ...console, warn() {} },
      require: id => id === 'node-pty' ? { spawn: impl } : id === 'electron' ? { app: { getPath: () => os.tmpdir() } } : require(id) })
    const { PtyManager } = mod.exports
    const pm = new PtyManager(() => ({ isDestroyed: () => false, send() {} }))
    const seen = []
    pm.addSink({ id: 'plain', onSpawn() {}, onData() {}, onExit() {} })
    pm.addSink({ id: 'status', onSpawn() {}, onData() {}, onExit() {}, onUserInput: (ptyId, paneId, data) => { seen.push([ptyId, paneId, data]); order.push('sink') } })
    pm.addSink({ id: 'broken', onSpawn() {}, onData() {}, onExit() {}, onUserInput: () => { throw new Error('boom') } })
    pm.spawn({ paneId: 'p', cols: 80, rows: 24 })
    const ptyId = pm.ptyIdForPane('p')
    pm.write(ptyId, 'a')
    check(seen.length === 1 && seen[0][0] === ptyId && seen[0][1] === 'p' && seen[0][2] === 'a', 'write tells onUserInput the pty, the pane and the data')
    check(order.join() === 'sink,pty' && writes.includes('a'), 'the sink hears the input before it reaches the pty, and a throwing sink never blocks it')
    pm.write(ptyId, ''); pm.write('missing', 'x')
    check(seen.length === 1, 'empty writes and unknown ptys notify nothing')
    pm.killAll()
  }
  // buildAskAnswerKeys (E2-FR-20, 21).
  {
    const K = load('src/shared/askAnswerKeys.ts')
    const keys = groups => groups.map(g => 'raw' in g ? g.raw : `[${g.text}]`)
    const opts = n => Array.from({ length: n }, (_, i) => ({ label: `Opcion ${i + 1}` }))
    const single = (n = 3, extra = {}) => ({ question: 'Cual?', header: 'Elegir', multiSelect: false, options: opts(n), ...extra })
    const multi = (n = 4) => ({ question: 'Cuales?', header: 'Varias', multiSelect: true, options: opts(n) })
    check(K.ANSWER_STEP_MS === 1000 && K.ASK_AUTO_ADVANCE_MS === 200 && K.MAX_ANSWER_GROUPS === 24 && K.ASK_MAX_OPTIONS === 8 && K.ASK_MAX_QUESTIONS === 8, 'answer constants match the contract')
    check(keys(K.buildAskAnswerKeys({ questions: [single()] }, [{ options: [1] }])).join('|') === '2', 'a lone single select is its digit (no review tab)')
    check(keys(K.buildAskAnswerKeys({ questions: [multi()] }, [{ options: [2, 0] }])).join('|') === `1|3|${K.KEY_NEXT}|1`, 'a lone multi select checks each option in its own group, moves on and submits')
    check(keys(K.buildAskAnswerKeys({ questions: [single()] }, [{ options: [], other: 'mi texto' }])).join('|') === '4|[mi texto]|\r', 'Other in a single select writes its digit, the raw text and Enter')
    check(keys(K.buildAskAnswerKeys({ questions: [multi(2)] }, [{ options: [1], other: 'extra' }])).join('|') === `2|3|[extra]|\r|${K.KEY_NEXT}|1`, 'Other in a multi select comes after the checked options')
    const eight = K.buildAskAnswerKeys({ questions: [single(8)] }, [{ options: [], other: 'otra' }])
    check(keys(eight)[0] === '9' && keys(eight).length === 3, '8 options plus Other: Other writes "9"')
    check(keys(K.buildAskAnswerKeys({ questions: [single(), multi()] }, [{ options: [0] }, { options: [1, 3] }])).join('|') === `1|2|4|${K.KEY_NEXT}|1`, 'two questions (single then multi) end on the review tab Submit')
    check(keys(K.buildAskAnswerKeys({ questions: [single(), single()] }, [undefined, { options: [2] }])).join('|') === `${K.KEY_NEXT}|3|1`, 'an unanswered question of a multi question ask skips its tab')
    check(K.buildAskAnswerKeys({ questions: [single(), single()] }, [undefined, { options: [] }]).length === 0, 'nothing answered builds nothing')
    check(K.buildAskAnswerKeys({ questions: [single()] }, [{ options: [] }]).length === 0, 'a lone unanswered question builds nothing')
    check(K.buildAskAnswerKeys({ questions: [single()] }, [{ options: [0, 1] }]).length === 0 && K.buildAskAnswerKeys({ questions: [single()] }, [{ options: [3] }]).length === 0, 'two picks in a single select or an index out of range build nothing')
    check(K.buildAskAnswerKeys({ questions: [single(9)] }, [{ options: [0] }]).length === 0, 'a question with 9 options is not answerable from the phone')
    check(K.buildAskAnswerKeys({ questions: Array.from({ length: 9 }, () => single()) }, Array.from({ length: 9 }, () => ({ options: [0] }))).length === 0, 'more than 8 questions are not answerable')
    check(!K.askQuestionsValid([single(2, { options: [{ label: 'x'.repeat(201) }] })]) && !K.askQuestionsValid([single(2, { options: [{ label: 'a', description: 'd'.repeat(501) }] })]) && K.askQuestionsValid([single(2, { options: [{ label: 'x'.repeat(200), description: 'd'.repeat(500) }] })]), 'label <= 200 and description <= 500')
    const big = K.buildAskAnswerKeys({ questions: [multi(8), multi(8), multi(8)] }, [{ options: [0, 1, 2, 3, 4, 5, 6, 7] }, { options: [0, 1, 2, 3, 4, 5, 6, 7] }, { options: [0, 1, 2, 3, 4, 5, 6, 7] }])
    check(big.length > K.MAX_ANSWER_GROUPS, 'three full multi selects pass the 24 group cap (the UI falls back to the terminal)')
    const seventeen = K.buildAskAnswerKeys({ questions: [multi(8), multi(8)] }, [{ options: [0, 1, 2, 3, 4, 5, 6] }, { options: [0, 1, 2, 3, 4, 5, 6] }])
    check(seventeen.length === 17 && seventeen.every(g => K.groupData(g).length < 8192), 'a 17 group answer fits under the cap, each group well under the 8192 input limit')
    check(K.sanitizeAskFreeText('a\x1b[31mb\r\nc\nd\te\u0085f\u2028g') === 'a[31mb c def g', 'sanitizeAskFreeText drops ESC and control characters and turns line breaks into spaces')
    check(K.sanitizeAskFreeText('x'.repeat(2500)).length === 2000 && K.sanitizeAskFreeText('   ') === '', 'free text caps at 2000 and trims')
    check(K.buildAskAnswerKeys({ questions: [single()] }, [{ options: [], other: ' \n ' }]).length === 0, 'a blank Other is no answer')
    check(K.selectionAnswered(single(), { options: [0] }) && !K.selectionAnswered(single(), { options: [] }) && K.selectionAnswered(multi(), { options: [], other: 'x' }), 'selectionAnswered follows the same rules')
  }
}
