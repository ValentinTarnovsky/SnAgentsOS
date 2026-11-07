// App 2.10.0 (schema 21, settings.agents.autoYes): main answers Claude Code
// permission prompts in the PermissionRequest hook's response body. Covers the
// pure decision, the schema key, the HookServer response over real HTTP, the
// StatusManager wiring (live console, log line, no pending request) and both
// together end to end.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
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

const ALLOW = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'

function testDecision() {
  const A = load('src/main/status/autoYes.ts')
  const base = { event: 'PermissionRequest', toolName: 'Bash', permissionMode: 'bypassPermissions', consoleKnown: true }
  check(A.AUTO_YES_ALLOW_BODY === ALLOW, 'the allow body is the documented PermissionRequest decision')
  check(A.autoYesDecision({ ...base, mode: 'off' }) === null && A.autoYesDecision({ ...base, mode: undefined }) === null && A.autoYesDecision({ ...base, mode: 'yes' }) === null, 'off, missing or junk mode never answers')
  check(A.autoYesDecision({ ...base, mode: 'bypass' }) === 'allow' && A.autoYesDecision({ ...base, mode: 'all' }) === 'allow', 'a bypass session prompt is answered in bypass and all')
  for (const pm of ['default', 'plan', 'acceptEdits', 'auto', 'dontAsk', undefined]) {
    check(A.autoYesDecision({ ...base, mode: 'bypass', permissionMode: pm }) === null, `bypass mode leaves a ${pm ?? 'missing'} permission_mode to the user`)
    check(A.autoYesDecision({ ...base, mode: 'all', permissionMode: pm }) === 'allow', `all answers a ${pm ?? 'missing'} permission_mode too`)
  }
  for (const tool of ['AskUserQuestion', 'ExitPlanMode']) {
    check(A.autoYesDecision({ ...base, mode: 'all', toolName: tool }) === null, `${tool} is never answered`)
  }
  check(A.autoYesDecision({ ...base, mode: 'all', toolName: undefined }) === null && A.autoYesDecision({ ...base, mode: 'all', toolName: '' }) === null, 'a prompt without a tool name is left alone')
  check(['Bash', 'PowerShell', 'Edit', 'Write', 'WebFetch', 'mcp__srv__tool', 'Monitor'].every(toolName => A.autoYesDecision({ ...base, mode: 'all', toolName }) === 'allow'), 'any other tool is answered')
  check(A.autoYesDecision({ ...base, mode: 'all', consoleKnown: false }) === null, 'a console that is not a live pty of the app is never answered')
  check(A.autoYesDecision({ ...base, mode: 'all', nested: true }) === null, 'a claude -p sub-session is never widened')
  check(['PreToolUse', 'Notification', 'Stop', 'Elicitation'].every(event => A.autoYesDecision({ ...base, mode: 'all', event }) === null), 'only PermissionRequest is ever answered')
  check(A.permissionModeOf('bypassPermissions') === 'bypassPermissions' && A.permissionModeOf('default') === 'default' && A.permissionModeOf('manual') === undefined && A.permissionModeOf(7) === undefined && A.permissionModeOf('BYPASSPERMISSIONS') === undefined, 'permissionModeOf keeps only the documented values')
  const line = A.autoYesLogLine('pane-1', 'Bash', true, 'bypassPermissions')
  check(line === 'allow console=pane-1 tool=Bash teammate=1 mode=bypassPermissions', 'the log line names console, tool, teammate and mode')
  const hostile = A.autoYesLogLine('p\r\nx y', 'Bash rm -rf /tmp/*; echo', false, undefined)
  check(hostile === 'allow console=p tool=Bash teammate=0 mode=?', 'ids and tool names are their leading plain token: no command text, no line break (got ' + JSON.stringify(hostile) + ')')
}

const baseSettings = { defaultShell: {}, fontFamily: 'mono', fontSize: 13, scrollback: 1000, restoreLastWorkspace: true, confirmCloseRunning: true, sidebarCollapsed: false }
const config = (version, agents) => ({ version, workspaces: [{ id: 'w1', name: 'Uno', cwd: 'C:/a', panes: [{ id: 'p1', type: 'shell', title: 'Shell', color: '#fff', icon: 'terminal' }] }], presets: [], settings: { ...baseSettings, ...(agents === undefined ? {} : { agents }) }, activeWorkspaceId: 'w1' })

function testSchema() {
  const { parseConfig, CONFIG_VERSION } = load('src/main/store/schema.ts')
  check(CONFIG_VERSION >= 21, 'CONFIG_VERSION is 21 or later (autoYes since app 2.10.0)')
  const v20 = parseConfig(config(20))
  check(v20 && v20.version === CONFIG_VERSION && v20.settings.agents.autoYes === 'off', 'a v20 config gains autoYes off and is stamped with the current version')
  check(parseConfig(config(21, { autoYes: 'bypass' })).settings.agents.autoYes === 'bypass' && parseConfig(config(21, { autoYes: 'all' })).settings.agents.autoYes === 'all', 'bypass and all survive a parse')
  for (const junk of ['yes', true, 1, null, { on: true }]) {
    const cfg = parseConfig(config(21, { autoYes: junk, sidebarSort: 'smart' }))
    check(cfg.settings.agents.autoYes === 'off' && cfg.settings.agents.sidebarSort === 'smart', `junk ${JSON.stringify(junk)} falls back to off and keeps the other agent keys`)
  }
}

function manager(logs, settings) {
  const timers = new Map()
  let seq = 0
  const { StatusManager } = load('src/main/status/StatusManager.ts', {
    require: id => id === 'electron' ? { Notification: { isSupported: () => false } } : require(id),
    setTimeout: fn => { timers.set(++seq, fn); return seq }, clearTimeout: id => timers.delete(id),
  })
  const events = [], notices = []
  const { notificationSettingsSchema } = load('src/main/store/schema.ts')
  const m = new StatusManager(() => ({ isDestroyed: () => false, isFocused: () => false, webContents: { send: (_ch, e) => events.push(e) }, flashFrame() {} }), () => null, n => notices.push(n))
  m.setConfig(notificationSettingsSchema.parse({}))
  m.setAgentSettings(settings)
  m.setAutoYesLog(line => logs.push(line))
  m.onSpawn('pty', 'pane')
  return { m, events, notices, last: () => events.filter(e => 'state' in e).at(-1) }
}

function testStatusManager() {
  const logs = []
  const { m, notices, last } = manager(logs, { autoYes: 'bypass' })
  const perm = (rest = {}) => ({ consoleId: 'pane', ptyId: 'pty', sessionId: 'session', name: 'PermissionRequest', toolName: 'Bash', toolUseId: 't1', permissionMode: 'bypassPermissions', ...rest })
  check(m.autoYesFor(perm()) === 'allow' && logs.length === 1 && logs[0] === 'allow console=pane tool=Bash teammate=0 mode=bypassPermissions', 'bypass: a bypass prompt of a live console is answered and logged')
  check(m.autoYesFor(perm({ agentId: 'teammate-1' })) === 'allow' && logs.at(-1).includes('teammate=1'), 'a teammate prompt shown in the lead console is answered too')
  check(m.autoYesFor(perm({ permissionMode: 'default' })) === null && m.autoYesFor(perm({ permissionMode: undefined })) === null, 'bypass: a session in another mode keeps its prompt')
  check(m.autoYesFor(perm({ consoleId: 'stranger' })) === null && m.autoYesFor(perm({ ptyId: 'old-pty' })) === null, 'an unknown console or a stale pty id is never answered')
  check(m.autoYesFor(perm({ ptyId: '' })) === 'allow', 'a hook without the pty header still answers for a live console')
  check(m.autoYesFor(perm({ toolName: 'AskUserQuestion' })) === null && m.autoYesFor(perm({ toolName: 'ExitPlanMode' })) === null && m.autoYesFor(perm({ nested: true })) === null, 'questions, plans and sub-sessions are never answered')
  const answered = logs.length
  m.setAgentSettings({ autoYes: 'all' })
  check(m.autoYesFor(perm({ permissionMode: 'default' })) === 'allow', 'all: a prompt in any mode is answered')
  m.setAgentSettings({ autoYes: 'nope' })
  check(m.autoYesFor(perm()) === null && logs.length === answered + 1, 'a junk setting reads as off (nothing logged)')
  m.setAgentSettings({})
  check(m.autoYesFor(perm()) === null, 'no setting reads as off')
  // The hook the HookServer answered never becomes a request.
  m.setAgentSettings({ autoYes: 'bypass' })
  m.onHookEvent({ consoleId: 'pane', ptyId: 'pty', sessionId: 'session', name: 'UserPromptSubmit', prompt: 'go' })
  m.onHookEvent({ consoleId: 'pane', ptyId: 'pty', sessionId: 'session', name: 'PreToolUse', toolName: 'Bash', toolUseId: 't9', toolSummary: 'Bash: rm -f *' })
  const before = notices.length
  m.onHookEvent(perm({ toolUseId: 't9', autoApproved: true, toolSummary: 'Bash: rm -f *' }))
  check(last().state === 'working' && last().pendingCount === 0 && last().attention !== true && notices.length === before, 'an auto-approved PermissionRequest leaves no request, no attention and no notice')
  m.onHookEvent({ consoleId: 'pane', ptyId: 'pty', sessionId: 'session', name: 'PostToolUse', toolUseId: 't9' })
  check(last().state === 'working', 'its PostToolUse ends the tool as usual')
  m.onHookEvent(perm({ toolUseId: 't10', toolSummary: 'Bash: ls' }))
  check(last().state === 'action' && last().pendingCount === 1 && notices.length === before + 1, 'a prompt auto-yes did not answer is a request as before')
}

async function testHookServer() {
  const { HookServer, parseHookPayload } = load('src/main/status/HookServer.ts')
  check(parseHookPayload('pane', 'pty', 'PermissionRequest', { session_id: 's', tool_name: 'Bash', permission_mode: 'bypassPermissions' }).permissionMode === 'bypassPermissions' && parseHookPayload('pane', 'pty', 'PermissionRequest', { session_id: 's', permission_mode: 'whatever' }).permissionMode === undefined, 'parseHookPayload keeps a known permission_mode only')
  const server = new HookServer(), received = [], asked = []
  server.onEvent(e => received.push(e))
  const token = 'b'.repeat(32)
  const port = await server.start(0, token)
  const endpoint = `http://127.0.0.1:${port}/cc-hook/${token}`
  const post = (json, headers = { 'X-Console-Id': 'pane', 'X-Pty-Id': 'pty' }) => fetch(endpoint, { method: 'POST', headers, body: typeof json === 'string' ? json : JSON.stringify(json) })
  const permission = { hook_event_name: 'PermissionRequest', session_id: 'session', tool_use_id: 'x1', tool_name: 'Bash', permission_mode: 'bypassPermissions', tool_input: { command: 'rm -f *' } }
  try {
    let res = await post(permission)
    check(res.status === 200 && await res.text() === '' && received.at(-1).autoApproved === undefined, 'without a decider: 200 and an empty body, as before')
    server.setDecider(evt => { asked.push(evt.name); return evt.toolName === 'Bash' ? 'allow' : null })
    res = await post(permission)
    check(res.status === 200 && await res.text() === ALLOW && res.headers.get('content-type') === 'application/json', 'with an allow: the decision body, as JSON')
    check(received.at(-1).autoApproved === true && received.at(-1).permissionMode === 'bypassPermissions' && received.at(-1).toolUseId === 'x1', 'the event reaches the listener marked autoApproved, after the decision')
    res = await post({ ...permission, tool_name: 'Edit' })
    check(await res.text() === '' && received.at(-1).autoApproved === undefined, 'a null decision: empty body, not marked')
    const n = asked.length
    res = await post({ ...permission, hook_event_name: 'PreToolUse' })
    check(await res.text() === '' && asked.length === n, 'only a PermissionRequest asks the decider')
    res = await post('{not json')
    check(res.status === 200 && await res.text() === '' && asked.length === n, 'a malformed body: 200, empty, nobody asked')
    res = await post(permission, {})
    check(res.status === 200 && await res.text() === '' && asked.length === n, 'a claude outside the app (no console id): empty, nobody asked')
    server.setDecider(() => { throw new Error('boom') })
    res = await post(permission)
    check(res.status === 200 && await res.text() === '' && received.at(-1).autoApproved === undefined, 'a throwing decider is no answer: the prompt shows')
    server.setDecider(null)
    res = await post(permission)
    check(await res.text() === '', 'setDecider(null) turns it off')
  } finally {
    await server.stop()
  }
}

async function testEndToEnd() {
  const logs = []
  const { m, last } = manager(logs, { autoYes: 'bypass' })
  const { HookServer } = load('src/main/status/HookServer.ts')
  const server = new HookServer()
  server.onEvent(e => m.onHookEvent(e))
  server.setDecider(e => m.autoYesFor(e))
  const token = 'c'.repeat(32)
  const port = await server.start(0, token)
  const endpoint = `http://127.0.0.1:${port}/cc-hook/${token}`
  const post = (json) => fetch(endpoint, { method: 'POST', headers: { 'X-Console-Id': 'pane', 'X-Pty-Id': 'pty' }, body: JSON.stringify({ session_id: 'session', ...json }) })
  try {
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'wipe the temp dir' })
    await post({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'r1', tool_input: { command: 'cd /tmp/segt && rm -f *' } })
    const res = await post({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_use_id: 'r1', permission_mode: 'bypassPermissions', agent_id: 'N3-1', tool_input: { command: 'cd /tmp/segt && rm -f *' } })
    check(await res.text() === ALLOW, 'the overnight case: a teammate rm prompt in a bypass console is approved in the response')
    check(last().state === 'working' && last().pendingCount === 0, 'and the console never shows a request')
    check(logs.length === 1 && logs[0] === 'allow console=pane tool=Bash teammate=1 mode=bypassPermissions' && !logs[0].includes('/tmp') && !logs[0].includes('segt'), 'one log line, without the command')
    const ask = await post({ hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', permission_mode: 'bypassPermissions' })
    check(await ask.text() === '' && logs.length === 1, 'a question still waits for the user')
  } finally {
    await server.stop()
  }
}

async function main() {
  testDecision()
  testSchema()
  testStatusManager()
  await testHookServer()
  await testEndToEnd()
  console.log(`PASS: ${checks} auto-yes checks (decision table, schema 21, StatusManager wiring, HookServer response, end to end)`)
}

main().catch(err => { console.error(err); process.exit(1) })
