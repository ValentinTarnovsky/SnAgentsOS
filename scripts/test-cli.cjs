// snaos CLI suite (E8-FR-12..22, R30-11): addresses (ctlRefs), ANSI fallback,
// console tokens, cleanEnv, runtime.json, the shim (static and executed with
// the repo's Electron against a test server), user PATH with an injected
// registry, the skill in a temp CLAUDE_CONFIG_DIR, `notify` custom notices
// (Discord, ntfy, router, native), CtlServer over a real temp pipe (401, 403,
// 413, caller from the token), every handler (ls, open, spawn, send, read,
// wait incl. noTurnObserved / timeout / cancel / 32 waiters, status, notify
// rate, note), cliEntry (parser, stdin, --file, --json, exit codes, dead pid)
// and CliService end to end. Same esbuild + vm harness as test-status.cjs.
// Never touches the real HKCU, ~/.claude or the app's data folder.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawnSync, spawn } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const win = process.platform === 'win32'
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
const warnings = []
const quietConsole = { ...console, warn: (...a) => warnings.push(a.join(' ')) }
const sandbox = { console: quietConsole, process, Buffer, URL, AbortController, TextEncoder, TextDecoder, structuredClone, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate }
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'node-pty', '@xterm/headless', '@xterm/addon-serialize', '@xterm/addon-unicode11'], alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, ...sandbox, ...overrides })
  return mod.exports
}
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-cli-test-'))
const tmp = (name) => { const d = path.join(tmpRoot, name); fs.mkdirSync(d, { recursive: true }); return d }
const rand = () => Math.random().toString(16).slice(2, 10)
// A unix socket path is capped near 104 bytes on macOS, whose tmpdir alone
// (/var/folders/xx/<28 chars>/T) takes about 50: keep the sockets in a short
// folder of their own instead of under tmpRoot.
const sockRoot = win ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'sn-'))
const pipeName = () => (win ? `\\\\.\\pipe\\snaos-test-${rand()}` : path.join(sockRoot, `s-${rand()}.sock`))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --- A. Pure helpers ---------------------------------------------------------

function refChecks() {
  const R = load('src/shared/ctlRefs.ts')
  const list = {
    workspaces: [
      // Sidebar order: a favorite first, as Alt+1..9 shows it.
      { id: 'w-fav', name: 'Fav', cwd: 'C:/fav', panes: [{ id: 'p-f1', title: 'Claude', type: 'claude' }] },
      { id: 'w-api', name: 'api', cwd: 'C:/api', panes: [{ id: 'p-a1', title: 'Shell', type: 'shell' }, { id: 'p-a2', title: 'Codex', type: 'codex' }, { id: 'p-a3', title: 'Claude', type: 'claude' }] },
      { id: 'w-web', name: 'web', cwd: 'C:/web', panes: [{ id: 'p-w1', title: 'Shell', type: 'shell' }] },
      { id: 'w-dup1', name: 'Dup', cwd: '', panes: [] },
      { id: 'w-dup2', name: 'dup', cwd: '', panes: [] },
    ],
  }
  const ws = (ref) => R.resolveWorkspaceRef(list, ref)
  check(ws('w-web').ok && ws('w-web').workspace.id === 'w-web' && ws('w-web').index === 3, 'workspace by id, with its sidebar index')
  check(ws('API').ok && ws('API').workspace.id === 'w-api', 'workspace by exact name, case-insensitive')
  check(ws('1').ok && ws('1').workspace.id === 'w-fav' && ws('2').workspace.id === 'w-api', 'workspace by 1-based sidebar index (favorites first)')
  check(!ws('dup').ok && ws('dup').code === 'ambiguous' && /w-dup1/.test(ws('dup').message), 'a duplicated name is ambiguous and lists the candidates')
  check(!ws('9').ok && ws('9').code === 'not_found' && !ws('nope').ok && ws('').code === 'bad_request', 'out of range, unknown and empty references')
  const c = (scope, ref, caller = null) => R.resolveConsoleRef(list, scope, ref, caller)
  check(c('w-api', '2').ok && c('w-api', '2').pane.id === 'p-a2' && c('w-api', '2').index === 2, 'console by grid index in the scope workspace')
  check(c(null, 'api:3').ok && c(null, 'api:3').pane.id === 'p-a3' && c('w-fav', 'web:1').pane.id === 'p-w1', '<workspace>:<index> addresses another workspace')
  check(c(null, '2:1').ok && c(null, '2:1').pane.id === 'p-a1', '<sidebar index>:<index>')
  check(c(null, 'p-w1').ok && c(null, 'p-w1').workspace.id === 'w-web', 'console by pane id anywhere')
  check(c('w-api', 'codex').ok && c('w-api', 'codex').pane.id === 'p-a2', 'console by exact title, case-insensitive')
  check(c('w-api', 'claude').ok && c('w-api', 'claude').pane.id === 'p-a3', 'a title resolves in the scope workspace first')
  check(!c('w-web', 'claude').ok && c('w-web', 'claude').code === 'ambiguous', 'a title repeated across workspaces (none in scope) is ambiguous')
  check(c('w-api', 'self', 'p-w1').ok && c('w-api', 'self', 'p-w1').pane.id === 'p-w1', 'self is the caller console, whatever the scope')
  check(!c('w-api', 'self', null).ok && c('w-api', 'self', null).code === 'bad_request', 'self with the master token is bad_request')
  check(!c(null, '2').ok && c(null, '2').code === 'bad_request', 'an index without any workspace is bad_request')
  check(!c('w-api', '7').ok && c('w-api', '7').code === 'not_found' && !c(null, 'api:9').ok && c(null, 'api:9').code === 'not_found', 'out of range indexes are not_found')
  check(R.workspaceOfPane(list, 'p-a3').workspace.id === 'w-api' && R.workspaceOfPane(list, 'x') === null, 'workspaceOfPane')
}

function ansiChecks() {
  const A = load('src/shared/ansi.ts')
  check(A.stripAnsi('\x1b[1;32mgreen\x1b[0m text') === 'green text', 'CSI SGR removed')
  check(A.stripAnsi('\x1b]0;title\x07after') === 'after' && A.stripAnsi('\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\') === 'link', 'OSC with BEL and with ST removed')
  check(A.stripAnsi('\x1b[?2004h\x1b[2J\x1b[Hprompt> ') === 'prompt>', 'private modes, clear and cursor moves removed')
  check(A.stripAnsi('Working |\rWorking /\rWorking -\rDone      \n') === 'Done\n', 'a spinner redrawn with CR keeps its last frame')
  check(A.stripAnsi('abcdef\rXY') === 'XYcdef' && A.stripAnsi('abcdef\rXY\x1b[K') === 'XY' && A.stripAnsi('abc\x1b[2Kz') === '   z', 'CR overwrites in place; erase in line (CSI K, 2K) drops the rest')
  check(A.stripAnsi('abc\b\bX') === 'aXc' && A.stripAnsi('line1\r\nline2') === 'line1\nline2', 'backspace overwrites, CRLF is one break')
  check(A.stripAnsi('arregl\u00e1 \u00f1and\u00fa \u{1F600}') === 'arregl\u00e1 \u00f1and\u00fa \u{1F600}', 'UTF-8 text (accents, emoji) intact')
  check(A.stripAnsi('\x1bPq#0;2;0;0;0\x1b\\ok\x1b(B') === 'ok', 'DCS strings and charset designations removed')
  check(JSON.stringify(A.tailLines('a\nb\nc\n\n\n', 2)) === '["b","c"]' && A.tailLines('x', 0).length === 0, 'tailLines drops trailing blanks, then keeps the last N')
  const H = load('src/main/cli/handlers.ts')
  check(H.oneLine('  dos\nlineas\t y\u0007 bell ', 120) === 'dos lineas y bell', 'oneLine flattens controls and whitespace')
  const clipped = H.oneLine('a'.repeat(119) + '\u{1F600}', 120)
  check(clipped.length === 119, 'oneLine never splits a surrogate pair at the cap')
  // The rules come from the platform argument, never the host: every OS runs both.
  check(H.samePathKey('C:\\Repo\\', 'win32') === H.samePathKey('c:/repo', 'win32') && H.samePathKey('C:\\Repo\\', 'win32') === 'c:\\repo', 'paths compare case-insensitively without trailing separators on Windows')
  check(H.samePathKey('/srv/Repo/', 'linux') === '/srv/Repo' && H.samePathKey('/srv/Repo', 'linux') !== H.samePathKey('/srv/repo', 'linux') && H.samePathKey('/srv/a/../Repo//', 'darwin') === '/srv/Repo', 'POSIX paths keep their case and lose the trailing slash')
}

// --- B/C. Tokens and env ---------------------------------------------------

function tokenChecks() {
  const { CtlTokens, newToken } = load('src/main/cli/CtlTokens.ts')
  const master = newToken()
  check(/^[0-9a-f]{64}$/.test(master), 'tokens are 64 hex (256 bits)')
  const t = new CtlTokens(master)
  const a = t.issue('pty-1', 'pane-1', 'ws-1')
  const b = t.issue('pty-2', 'pane-2', 'ws-1')
  check(a !== b && a !== master && /^[0-9a-f]{64}$/.test(a), 'two consoles get different tokens, neither the master')
  check(t.resolve(master) === 'master', 'the master token resolves to master')
  const who = t.resolve(a)
  check(who && who.paneId === 'pane-1' && who.ptyId === 'pty-1' && who.workspaceId === 'ws-1', 'a console token resolves to its pane, pty and workspace')
  t.revoke('pty-1')
  check(t.resolve(a) === null && t.resolve(b).paneId === 'pane-2' && t.size === 1, 'a revoked token is rejected, the others keep working')
  const c = t.issue('pty-2', 'pane-2', 'ws-1')
  check(t.resolve(b) === null && t.resolve(c).paneId === 'pane-2', 're-issuing for the same pty replaces its token')
  check(t.resolve('') === null && t.resolve('x'.repeat(300)) === null && t.resolve(42) === null && t.resolve(master.slice(0, 63)) === null, 'empty, oversized, non-string and truncated tokens are rejected')
}

function envChecks() {
  const electron = { app: { getPath: () => tmp('userdata') } }
  const { cleanEnv } = load('src/main/pty/shellResolver.ts', { require: (id) => (id === 'electron' ? electron : require(id)) })
  const saved = { ...process.env }
  try {
    process.env.SNAOS_CTL_TOKEN = 'parent-token'
    process.env.SNAOS_CTL_ENDPOINT = '\\\\.\\pipe\\parent'
    process.env.SNAOS_CLI = 'C:/parent/bin/snaos.cmd'
    process.env.ELECTRON_RUN_AS_NODE = '1'
    process.env.KEEP_ME = 'yes'
    const env = cleanEnv({ SNAOS_CTL_TOKEN: 'mine' }, [])
    check(env.SNAOS_CTL_TOKEN === 'mine' && !('SNAOS_CTL_ENDPOINT' in env) && !('SNAOS_CLI' in env), 'inherited SNAOS_* are dropped, our own extra wins')
    check(!Object.keys(env).some((k) => k.toUpperCase() === 'ELECTRON_RUN_AS_NODE') && env.KEEP_ME === 'yes', 'an inherited ELECTRON_RUN_AS_NODE is dropped, unrelated vars kept')
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  }
}

// --- D. runtime.json and shim ------------------------------------------------

function runtimeAndShimChecks() {
  const RF = load('src/main/cli/runtimeFile.ts')
  const dir = tmp('runtime')
  const file = path.join(dir, 'runtime.json')
  const data = { version: 1, pid: process.pid, appVersion: '2.0.0', startedAt: 1, transport: { kind: 'named-pipe', endpoint: '\\\\.\\pipe\\x' }, token: 'f'.repeat(64) }
  RF.writeRuntimeFile(file, data)
  check(JSON.stringify(RF.readRuntimeFile(file)) === JSON.stringify(data), 'runtime.json round-trips')
  check(fs.readdirSync(dir).length === 1, 'the atomic write leaves no temp file behind')
  check(fs.readFileSync(file)[0] !== 0xef, 'runtime.json is UTF-8 without BOM')
  RF.writeRuntimeFile(file, { ...data, pid: process.pid + 100000 })
  check(RF.removeRuntimeFileIfOwned(file) === false && fs.existsSync(file), "another process's runtime.json is never removed")
  RF.writeRuntimeFile(file, data)
  check(RF.removeRuntimeFileIfOwned(file) === true && !fs.existsSync(file), 'our own runtime.json is removed on quit')
  fs.writeFileSync(file, '{broken')
  check(RF.readRuntimeFile(file) === null && RF.removeRuntimeFileIfOwned(file) === false, 'a malformed runtime.json reads as null and is left alone')

  const S = load('src/main/cli/shim.ts')
  const target = { execPath: 'C:\\Apps\\100%\\SnAgentsOS.exe', cliPath: 'C:\\Apps\\100%\\resources\\app.asar\\out\\main\\cli.js', runtimePath: 'C:\\Users\\x\\AppData\\Roaming\\snagentsos\\runtime.json' }
  const cmd = S.windowsShim(target)
  check(cmd.split('\r\n')[0] === '@echo off' && cmd.split('\r\n')[1] === 'setlocal', 'the .cmd starts with @echo off + setlocal (no ELECTRON_RUN_AS_NODE leak)')
  check(cmd.includes('if not exist "C:\\Apps\\100%%\\SnAgentsOS.exe" (echo SnAgentsOS is not running 1>&2 & exit /b 5)'), 'the exe check comes first and exits 5; % doubled')
  check(cmd.includes('--runtime "C:\\Users\\x\\AppData\\Roaming\\snagentsos\\runtime.json" %*') && cmd.trimEnd().endsWith('exit /b %errorlevel%'), 'it forwards the arguments with --runtime and keeps the exit code')
  check(!/[0-9a-f]{64}/.test(cmd) && !/TOKEN/i.test(cmd), 'the shim never contains a token')
  const sh = S.posixShim({ execPath: "/opt/it's/snagentsos", cliPath: '/opt/app/cli.js', runtimePath: '/home/u/.config/snagentsos/runtime.json' })
  check(sh.startsWith('#!/bin/sh\n') && sh.includes("'/opt/it'\\''s/snagentsos'") && sh.includes('exit 5') && sh.includes('"$@"'), 'the POSIX shim quotes paths and exits 5 without the exe')
  const bin = tmp('bin-static')
  const written = S.writeShim(bin, target, 'win32')
  check(path.basename(written) === 'snaos.cmd' && fs.readFileSync(written, 'utf8') === cmd, 'writeShim writes <bin>/snaos.cmd on Windows')
  check(S.shimFileName('linux') === 'snaos', 'the POSIX shim is <bin>/snaos')
}

// --- E. User PATH (injected registry) ----------------------------------------

async function userPathChecks() {
  const U = load('src/main/cli/userPath.ts')
  const raw = '%USERPROFILE%\\bin;C:\\Users\\Martín\\tools;C:\\Tools'
  check(U.parseReadOutput(`\r\n=${Buffer.from(raw, 'utf8').toString('base64')}\r\n`) === raw, 'the registry read output (base64 of UTF-8) parses to the raw value, accents included')
  check(U.parseReadOutput('@\r\n') === '', 'a missing value reads as empty')
  let threw = 0
  for (const bad of ['', 'Access denied', '=not base64!']) { try { U.parseReadOutput(bad) } catch { threw++ } }
  check(threw === 3, 'a failed or garbled read throws instead of reading as an empty PATH (a write would wipe the user PATH)')
  check(U.writeScript(raw).includes(Buffer.from(raw, 'utf8').toString('base64')) && !U.writeScript(raw).includes('%USERPROFILE%') && /ExpandString/.test(U.writeScript(raw)), 'the write script carries the value as base64 and stores REG_EXPAND_SZ')
  let rejected = 0
  for (const bad of ["Environment'; rm x", 'a b']) { try { U.readScript(bad) } catch { rejected++ } }
  check(rejected === 2, 'only plain subkey paths reach a script')
  const failing = { read: async () => { throw new Error('reg unavailable') }, write: async () => { throw new Error('must not write') }, broadcast: async () => {} }
  let addFailed = false
  try { await U.addToUserPath('C:\\x\\bin', failing) } catch { addFailed = true }
  check(addFailed, 'a failed read aborts the add without writing')
  if (win) {
    // The real PowerShell path against a throwaway HKCU test key (never Environment), removed afterwards.
    const subKey = `Software\\SnAgentsOSTest-${rand()}`
    const reg = U.powershellRegistry(subKey, false)
    try {
      check((await reg.read()) === '', 'a test key without Path reads as empty')
      const value = '%USERPROFILE%\\.local\\bin;C:\\Users\\Martín Ñandú\\bin;C:\\Tools'
      await reg.write(value)
      check((await reg.read()) === value, 'PowerShell write + read round-trips accents and keeps %VAR% unexpanded')
      const q = spawnSync('reg.exe', ['query', `HKCU\\${subKey}`, '/v', 'Path'], { encoding: 'utf8', windowsHide: true })
      check(/REG_EXPAND_SZ/.test(q.stdout), 'the value is stored as REG_EXPAND_SZ')
      await U.addToUserPath('C:\\Data\\snagentsos\\bin', reg)
      check((await reg.read()) === `${value};C:\\Data\\snagentsos\\bin`, 'add through the real registry path keeps every other entry as written')
      await U.removeFromUserPath('C:\\Data\\snagentsos\\bin', reg)
      check((await reg.read()) === value, 'remove through the real registry path restores the value')
    } finally {
      spawnSync('reg.exe', ['delete', `HKCU\\${subKey}`, '/f'], { windowsHide: true })
    }
  }
  const dir = 'C:\\Users\\x\\AppData\\Roaming\\snagentsos\\bin'
  let value = '%USERPROFILE%\\.local\\bin;C:\\Tools;%JAVA_HOME%\\bin'
  const writes = []
  let broadcasts = 0
  const reg = { read: async () => value, write: async (v) => { writes.push(v); value = v }, broadcast: async () => { broadcasts++ } }
  await U.addToUserPath(dir, reg)
  check(value === `%USERPROFILE%\\.local\\bin;C:\\Tools;%JAVA_HOME%\\bin;${dir}` && broadcasts === 1, 'add appends our folder and keeps every %VAR% unexpanded, then broadcasts')
  await U.addToUserPath(dir.toLowerCase() + '\\', reg)
  check(writes.length === 1 && broadcasts === 1, 'adding again (other case, trailing slash) changes nothing')
  check(await U.isInUserPath(dir, reg), 'isInUserPath sees it')
  value = `${dir};C:\\Tools;;${dir}\\sub;%JAVA_HOME%\\bin;"${dir}"`
  await U.removeFromUserPath(dir, reg)
  check(value === `C:\\Tools;${dir}\\sub;%JAVA_HOME%\\bin`, 'remove drops only our entry (quoted too), keeps other entries and %VAR%')
  const before = writes.length
  await U.removeFromUserPath(dir, reg)
  check(writes.length === before, 'removing when absent writes nothing')
  value = ''
  await U.addToUserPath(dir, reg)
  check(value === dir, 'an empty user PATH becomes just our folder')
}

// --- F. Skill ------------------------------------------------------------------

function skillChecks() {
  const K = load('src/main/cli/skillInstaller.ts')
  const env = { CLAUDE_CONFIG_DIR: tmp('claude') }
  const dir = path.join(env.CLAUDE_CONFIG_DIR, 'skills', 'snagentsos')
  check(K.skillDir(env) === dir, 'the skill lives under CLAUDE_CONFIG_DIR/skills/snagentsos')
  check(K.skillStatus('2.0.0', env).state === 'missing', 'not installed by default (never installs on its own)')
  check(K.refreshSkillOnStartup('2.0.0', env).state === 'missing' && !fs.existsSync(dir), 'the startup refresh never installs')
  const st = K.installSkill('2.0.0', env)
  const md = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')
  check(st.state === 'installed' && st.version === '2.0.0', 'install writes it and reports installed v2.0.0')
  check(md.startsWith('---\nname: snagentsos\ndescription: ') && md.includes('<!-- managed-by: snagentsos v2.0.0 -->') && md.includes('snaos help --agent'), 'SKILL.md has the front matter, our marker and the pointer to the guide')
  check(K.skillStatus('2.1.0', env).state === 'outdated', 'another app version reads as outdated')
  const ref = K.refreshSkillOnStartup('2.1.0', env)
  check(ref.state === 'installed' && fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8').includes('v2.1.0'), 'after an update the stub is rewritten with the new version')
  check(K.removeSkill('2.1.0', env).state === 'missing' && !fs.existsSync(dir), 'remove deletes our folder')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: snagentsos\n---\nmine')
  check(K.skillStatus('2.0.0', env).state === 'foreign', 'a folder without our marker is foreign')
  check(K.removeSkill('2.0.0', env).error === 'foreign' && fs.existsSync(path.join(dir, 'SKILL.md')), 'remove never deletes a foreign folder')
  check(K.installSkill('2.0.0', env).error === 'foreign' && fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8').endsWith('mine'), 'install never overwrites a foreign folder')
  check(K.repairSkill('2.0.0', env).state === 'foreign', 'repair leaves a foreign folder alone')
  check(K.skillStub('9.9.9').includes('If a command says SnAgentsOS is not running'), 'the stub tells the agent to stop when the app is down')
}

// --- G. notify: custom notices ---------------------------------------------------

async function noticeChecks() {
  const { DiscordNotifier } = load('src/main/status/DiscordNotifier.ts')
  const sent = []
  const fetcher = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 204, body: { cancel: async () => {} } } }
  const discord = new DiscordNotifier(fetcher, async () => {})
  const cfg = { enabled: true, webhookUrl: 'https://discord.com/api/webhooks/12345678901234567/abc_DEF-1', userId: '', notifyDone: false, notifyAction: false }
  discord.setConfig(cfg)
  const config = { workspaces: [{ id: 'w1', name: 'Front', panes: [{ id: 'p1', title: 'Builder' }] }], settings: { notifications: { onlyWhenAway: false } } }
  discord.notifyCustom({ kind: 'custom', paneId: 'p1', title: 'T'.repeat(100), body: 'build listo @everyone\u0007\n' + 'x'.repeat(400) }, config)
  await sleep(20)
  check(sent.length === 1, 'a custom notice goes out with notifyDone/notifyAction off (only `enabled` matters)')
  const content = sent[0].body.content
  const head = content.split('\n')[0]
  check(head.startsWith('T'.repeat(80) + ': build listo @everyone') && !head.includes('T'.repeat(81)), 'title clipped to 80, body follows')
  check(!/[\u0000-\u0008\u000b-\u001f]/.test(content) && content.includes('\nFront / Builder\n'), 'controls stripped; the console place follows')
  check(JSON.stringify(sent[0].body.allowed_mentions) === '{"parse":[],"users":[]}', 'allowed_mentions parses nothing (no @everyone ping)')
  discord.setConfig({ ...cfg, enabled: false })
  discord.notifyCustom({ kind: 'custom', paneId: null, title: 'x', body: 'y' }, config)
  await sleep(10)
  check(sent.length === 1, 'Discord off: nothing is sent')

  const { NtfyNotifier } = load('src/main/status/NtfyNotifier.ts', { require: (id) => (id === 'electron' ? {} : require(id)) })
  const pushes = []
  const ntfy = new NtfyNotifier(async (url, init) => { pushes.push(JSON.parse(init.body)); return { ok: true, status: 200, body: { cancel: async () => {} }, headers: { get: () => null } } }, async () => {})
  ntfy.setConfig({ enabled: true, server: 'https://ntfy.sh', topic: 'my_topic', token: '', notifyDone: false, notifyAction: false })
  check(ntfy.wantsCustom() === true, 'ntfy wants a custom notice with a valid topic, whatever done/action say')
  ntfy.notifyCustom({ kind: 'custom', paneId: 'p1', title: 'Build', body: 'listo' }, config, 'http://h:1/#ws=w1&pane=p1')
  await sleep(10)
  check(pushes.length === 1 && pushes[0].title === 'Build' && pushes[0].message === 'listo\nFront / Builder' && pushes[0].click === 'http://h:1/#ws=w1&pane=p1' && pushes[0].priority === 3, 'ntfy publishes title, text + console and the deep link')

  const { createNoticeRouter } = load('src/main/status/noticeRouter.ts')
  const routed = []
  const env = { away: false, onlyWhenAway: false }
  const router = createNoticeRouter({
    discord: { notify() {}, notifyCustom: (n) => routed.push(['discord', n.body]) },
    ntfy: { notify() {}, wants: () => true, wantsCustom: () => true, notifyCustom: (n, c, click) => routed.push(['ntfy', click]) },
    loadConfig: () => ({ ...config, settings: { notifications: { onlyWhenAway: env.onlyWhenAway } } }),
    isAway: () => env.away,
    isPaneViewed: () => true,
    deepLinkBase: () => 'http://100.64.0.2:4517',
  })
  router.routeCustom({ kind: 'custom', paneId: 'p1', title: 't', body: 'b' })
  check(routed.length === 2 && routed[1][1] === 'http://100.64.0.2:4517/#ws=w1&pane=p1', 'routeCustom: Discord and ntfy (with the deep link), even for a pane a phone watches')
  router.routeCustom({ kind: 'custom', paneId: null, title: 't', body: 'b' })
  check(routed.length === 4 && routed[3][1] === undefined, 'an external terminal (no pane) pushes without a click')
  env.onlyWhenAway = true
  router.routeCustom({ kind: 'custom', paneId: 'p1', title: 't', body: 'b' })
  check(routed.length === 4, '"only when away" + an active PC silences the remote channels too')

  const shown = []
  class FakeNotification { constructor(o) { this.o = o } on() {} show() { shown.push(this.o) } static isSupported() { return true } }
  const electron = { Notification: FakeNotification }
  const { StatusManager } = load('src/main/status/StatusManager.ts', { require: (id) => (id === 'electron' ? electron : require(id)) })
  const sm = new StatusManager(() => null, () => null)
  check(sm.notifyCustom('p1', 'Title', 'Body') === false && shown.length === 0, 'notifications disabled: no native notification')
  sm.setConfig({ enabled: true })
  check(sm.notifyCustom('p1', 'Build', 'listo') === true && shown.length === 1 && shown[0].title === 'Build' && shown[0].body === 'listo', 'enabled: a native notification with the caller title and text')
}

// --- H/I. CtlServer and handlers ----------------------------------------------------

function rpcRaw(endpoint, { token, body, headers = {}, method = 'POST', urlPath = '/v1/rpc' } = {}) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body ?? { v: 1, method: 'ping', params: {} })
    const req = http.request({ socketPath: endpoint, method, path: urlPath, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = JSON.parse(text) } catch { /* not JSON */ }
        resolve({ status: res.statusCode, json })
      })
    })
    req.on('error', reject)
    req.end(data)
  })
}

const H = () => load('src/main/cli/handlers.ts')

/** A renderer model + bus fake, PtyManager and StatusManager views. */
function fakeWorld() {
  const list = {
    workspaces: [
      { id: 'w1', name: 'api', cwd: 'C:\\repos\\api', panes: [{ id: 'p1', title: 'Claude', type: 'claude', presetId: 'pc' }, { id: 'p2', title: 'Shell', type: 'shell' }, { id: 'p3', title: 'Codex', type: 'codex', presetId: 'px' }] },
      { id: 'w2', name: 'srv', cwd: 'C:\\repos\\srv', setupId: 'ssh1', panes: [{ id: 'p4', title: 'Remote', type: 'shell' }, { id: 'p5', title: 'Local', type: 'shell', setupId: '' }] },
    ],
    activeWorkspaceId: 'w1',
    presets: [{ id: 'pc', name: 'Claude Code', type: 'claude' }, { id: 'px', name: 'Codex', type: 'codex' }],
    statusLines: { p1: 'corriendo tests' },
  }
  const ops = []
  const bus = {
    unavailable: false,
    readResult: { ok: true, data: { lines: ['uno', 'dos', 'tres'] } },
    async request(op) {
      ops.push(op)
      if (bus.unavailable) return { ok: false, error: 'desktop_unavailable' }
      if (op.kind === 'list') return { ok: true, data: JSON.parse(JSON.stringify(list)) }
      if (op.kind === 'spawn') return { ok: true, data: { paneId: 'p-new', index: 4, promptDelivery: op.prompt ? 'argv' : 'none' } }
      if (op.kind === 'read') return bus.readResult
      return { ok: true }
    },
  }
  const running = new Set(['p1', 'p2', 'p3', 'p4', 'p5'])
  const pty = {
    submits: [],
    submitResult: { ok: true },
    lastSubmit: {},
    lastOutput: {},
    ring: { p2: '\x1b[32mPS C:\\>\x1b[0m dir\r\nfile.txt\r\nspin |\r\x1b[Kspin /\r\x1b[Kdone\r\n' },
    ptyIdForPane: (id) => (running.has(id) ? `pty-${id}` : null),
    async submitToPane(ptyId, paneId, text, enter) { pty.submits.push({ ptyId, paneId, text, enter }); return pty.submitResult },
    lastSubmitAt: (id) => pty.lastSubmit[id],
    lastOutputAt: (id) => pty.lastOutput[id],
    tail: (id) => (running.has(id) ? pty.ring[id] ?? '' : null),
  }
  const states = {}
  const status = { stateOf: (id) => states[id] ?? null }
  const notices = []
  const config = { settings: { automation: { cliProtectSsh: true } }, workspaces: [] }
  return { list, ops, bus, running, pty, states, status, notices, config }
}

function makeHandlers(world, timing = { settleMs: 120, recentWorkingMs: 200, noTurnMs: 300, tickMs: 20 }, extra = {}) {
  const { CtlHandlers } = H()
  return new CtlHandlers({ bus: world.bus, pty: world.pty, status: world.status, config: () => world.config, notify: (n) => world.notices.push(n), appVersion: '2.0.0', timing, ...extra })
}

const never = () => new AbortController().signal
const call = (h, method, params = {}, caller = null, signal = never()) => h.handle(method, params, caller, signal)
const caller1 = { paneId: 'p1', ptyId: 'pty-p1', workspaceId: 'w1' }

async function serverChecks() {
  const { CtlServer } = load('src/main/cli/CtlServer.ts')
  const { CtlTokens, newToken } = load('src/main/cli/CtlTokens.ts')
  const master = newToken()
  const tokens = new CtlTokens(master)
  const consoleToken = tokens.issue('pty-p1', 'p1', 'w1')
  const seen = []
  const endpoint = pipeName()
  const server = new CtlServer({ kind: win ? 'named-pipe' : 'unix', endpoint }, (t) => tokens.resolve(t), async (method, params, caller) => {
    seen.push({ method, params, caller })
    return { ok: true, data: { pong: true, self: caller ? caller.paneId : null } }
  })
  await server.start()
  try {
    check(server.running, 'the server listens on a pipe / socket')
    const noTok = await rpcRaw(endpoint, {})
    check(noTok.status === 401 && noTok.json.error.code === 'unauthorized', 'no token: 401')
    check((await rpcRaw(endpoint, { token: 'f'.repeat(64) })).status === 401, 'a wrong token: 401')
    const revoked = tokens.issue('pty-x', 'px', 'w1')
    tokens.revoke('pty-x')
    check((await rpcRaw(endpoint, { token: revoked })).status === 401, 'a revoked console token: 401')
    check((await rpcRaw(endpoint, { token: master, headers: { Origin: 'http://evil.example' } })).status === 403, 'any Origin header: 403 (even with a valid token)')
    const big = await rpcRaw(endpoint, { token: master, body: JSON.stringify({ v: 1, method: 'ping', params: { pad: 'x'.repeat(2 * 1024 * 1024) } }) })
    check(big.status === 413, 'a 2 MB body: 413')
    const ok = await rpcRaw(endpoint, { token: master })
    check(ok.status === 200 && ok.json.ok && ok.json.data.self === null, 'ping with the master token: 200, no caller')
    const spoof = await rpcRaw(endpoint, { token: consoleToken, body: { v: 1, method: 'ping', params: {}, caller: { paneId: 'p9' } } })
    check(spoof.json.data.self === 'p1' && seen.at(-1).caller.paneId === 'p1', 'the caller comes from the console token; a caller in the body is ignored')
    check((await rpcRaw(endpoint, { token: master, body: '{nope' })).json.error.code === 'bad_request', 'invalid JSON: 200 with bad_request')
    check((await rpcRaw(endpoint, { token: master, body: { v: 1, method: 'rm -rf', params: {} } })).json.error.code === 'bad_request', 'an unknown method: bad_request')
    check((await rpcRaw(endpoint, { token: master, body: { v: 2, method: 'ping', params: {} } })).json.error.code === 'bad_request', 'another protocol version: bad_request')
    check((await rpcRaw(endpoint, { token: master, urlPath: '/other' })).status === 404, 'another path: 404')
  } finally {
    await server.stop()
  }
  check(!server.running, 'stop closes the listener')
}

async function handlerChecks() {
  // ls
  {
    const w = fakeWorld()
    w.states.p1 = { paneId: 'p1', state: 'working', precise: true }
    w.states.p3 = { paneId: 'p3', state: 'action', precise: false, reason: 'question' }
    w.running.delete('p2')
    const h = makeHandlers(w)
    const res = await call(h, 'ls', {}, caller1)
    const api = res.data.workspaces[0]
    check(res.ok && res.data.workspaces.length === 2 && api.index === 1 && api.active && api.name === 'api', 'ls lists every workspace with index, name and active')
    check(api.consoles[0].agentState === 'working' && api.consoles[0].precise === true && api.consoles[0].self === true && api.consoles[0].statusLine === 'corriendo tests' && api.consoles[0].presetName === 'Claude Code', 'console 1: state, precise, self, status line, preset')
    check(api.consoles[1].running === false && api.consoles[1].agentState === null && api.consoles[2].reason === 'question' && api.consoles[2].precise === false, 'running, null state and reason per console')
    const srv = res.data.workspaces[1]
    check(srv.consoles[0].sshProtected === true && srv.consoles[1].sshProtected === false, "a workspace profile protects its consoles; a pane with setupId '' is local")
    const one = await call(h, 'ls', { workspace: 'srv' })
    check(one.data.workspaces.length === 1 && one.data.workspaces[0].index === 2, 'ls --workspace filters, keeping the sidebar index')
    w.bus.unavailable = true
    check((await call(h, 'ls')).error.code === 'desktop_unavailable', 'no renderer: desktop_unavailable')
  }
  // open (Windows path rules pinned: the fake cwds are Windows folders)
  {
    const w = fakeWorld()
    const h = makeHandlers(w, undefined, { platform: 'win32' })
    const r = await call(h, 'open', { workspace: '2' })
    check(r.ok && w.ops.at(-1).kind === 'open' && w.ops.at(-1).workspaceId === 'w2', 'open 2 activates the second sidebar workspace')
    await call(h, 'open', { workspace: 'api', console: '3' })
    check(w.ops.at(-1).paneId === 'p3', 'open --console focuses that console')
    const known = await call(h, 'open', { path: 'c:\\REPOS\\api\\' })
    check(known.ok && known.data.workspaceId === 'w1' && known.data.composer === false, 'open --path matches a workspace cwd case-insensitively')
    const fresh = await call(h, 'open', { path: 'C:\\repos\\new' })
    check(fresh.ok && fresh.data.composer === true && fresh.data.created === false && w.ops.at(-1).kind === 'composer', 'open --path of a new folder opens the composer')
    check((await call(h, 'open', {})).error.code === 'bad_request', 'open without anything is bad_request')
  }
  // open --path with POSIX rules: case-sensitive, a trailing slash ignored.
  {
    const w = fakeWorld()
    w.list.workspaces[0].cwd = '/srv/api'
    const h = makeHandlers(w, undefined, { platform: 'linux' })
    const known = await call(h, 'open', { path: '/srv/api/' })
    check(known.ok && known.data.workspaceId === 'w1', 'open --path on POSIX matches the same folder with a trailing slash')
    const other = await call(h, 'open', { path: '/SRV/api' })
    check(other.ok && other.data.composer === true && w.ops.at(-1).kind === 'composer' && w.ops.at(-1).cwd === '/SRV/api', 'open --path on POSIX is case-sensitive: another case is another folder')
  }
  // spawn
  {
    const w = fakeWorld()
    const h = makeHandlers(w)
    const r = await call(h, 'spawn', { agent: 'codex', prompt: 'revisa el diff' }, caller1)
    const op = w.ops.at(-1)
    check(r.ok && r.data.paneId === 'p-new' && r.data.workspaceId === 'w1' && r.data.promptDelivery === 'argv' && r.data.index === 4, 'spawn codex answers paneId, index, workspace and delivery at once')
    check(op.kind === 'spawn' && op.presetId === 'px' && op.focus === false && op.prompt === 'revisa el diff', 'it resolves the first codex preset and does not steal the focus')
    await call(h, 'spawn', { agent: 'Claude Code', title: 'Rev\niewer', focus: true }, caller1)
    check(w.ops.at(-1).presetId === 'pc' && w.ops.at(-1).title === 'Rev iewer' && w.ops.at(-1).focus === true && !('prompt' in w.ops.at(-1)), 'by preset name, title flattened, --focus')
    await call(h, 'spawn', { agent: 'shell' }, caller1)
    check(w.ops.at(-1).paneType === 'shell' && !w.ops.at(-1).presetId, 'shell without a shell preset: a plain shell pane')
    check((await call(h, 'spawn', { agent: 'gemini' }, caller1)).error.code === 'not_found', 'an unknown agent is not_found')
    check((await call(h, 'spawn', { agent: 'claude', workspace: 'srv' }, caller1)).error.code === 'ssh_protected', 'a workspace with a Connection Profile: ssh_protected')
    const local = await call(h, 'spawn', { agent: 'claude', workspace: 'srv', noProfile: true }, caller1)
    check(local.ok && w.ops.at(-1).noProfile === true && w.ops.at(-1).workspaceId === 'w2', '--no-profile creates a local console there')
    w.config.settings.automation.cliProtectSsh = false
    check((await call(h, 'spawn', { agent: 'claude', workspace: 'srv' }, caller1)).ok, 'with cliProtectSsh off the profile workspace is allowed')
    check((await call(h, 'spawn', { agent: 'claude', prompt: 'x'.repeat(16385) })).error.code === 'bad_request', 'a prompt over 16384 is bad_request')
    const ext = await call(h, 'spawn', { agent: 'claude' }, null)
    check(ext.ok && w.ops.at(-1).workspaceId === 'w1', 'from an external terminal the active workspace is the scope')
  }
  // send
  {
    const w = fakeWorld()
    const h = makeHandlers(w)
    const r = await call(h, 'send', { console: '2', text: 'ls\n', enter: true }, caller1)
    check(r.ok && w.pty.submits[0].paneId === 'p2' && w.pty.submits[0].text === 'ls' && w.pty.submits[0].enter === true, 'send 2 --enter submits to console 2 of the caller workspace (trailing break dropped)')
    await call(h, 'send', { console: 'api:3', text: 'hola' }, null)
    check(w.pty.submits[1].paneId === 'p3' && w.pty.submits[1].enter === false, 'without --enter the text is typed, never submitted')
    check((await call(h, 'send', { console: 'srv:1', text: 'x' })).error.code === 'ssh_protected', 'a console with a profile: ssh_protected')
    w.running.delete('p2')
    check((await call(h, 'send', { console: '2', text: 'x' }, caller1)).error.code === 'not_running', 'a console without a live pty: not_running')
    w.pty.submitResult = { ok: false, error: 'multiline_unsafe' }
    check((await call(h, 'send', { console: '3', text: 'a\nb' }, caller1)).error.code === 'multiline_unsafe', 'multiline to a console without bracketed paste: multiline_unsafe')
    check((await call(h, 'send', { console: '3', text: 'x'.repeat(256 * 1024 + 1) }, caller1)).error.code === 'bad_request', 'over 256 KB: bad_request')
    check((await call(h, 'send', { console: 'self', text: 'x' }, null)).error.code === 'bad_request', 'self with the master token: bad_request')
    w.pty.submitResult = { ok: true }
    check((await call(h, 'send', { console: 'self', text: 'eco' }, caller1)).ok && w.pty.submits.at(-1).paneId === 'p1', 'sending to the calling console is allowed')
    check((await call(h, 'send', { console: 'claude', text: 'x' }, null)).ok, 'a title resolves')
  }
  // read
  {
    const w = fakeWorld()
    const h = makeHandlers(w)
    const r = await call(h, 'read', { console: '1', lines: 2 }, caller1)
    check(r.ok && JSON.stringify(r.data.lines) === '["dos","tres"]' && w.ops.at(-1).kind === 'read' && w.ops.at(-1).lines === 2, 'read asks the renderer for the xterm buffer and keeps the last N')
    w.bus.readResult = { ok: false, error: 'not_running' }
    const fb = await call(h, 'read', { console: '2' }, caller1)
    check(fb.ok && fb.data.fallback === true && JSON.stringify(fb.data.lines) === '["PS C:\\\\> dir","file.txt","done"]', 'no mounted xterm: main ring without ANSI, CR applied')
    check((await call(h, 'read', { console: '1', lines: 0 }, caller1)).error.code === 'bad_request', '--lines 0 is bad_request')
    w.bus.readResult = { ok: true, data: { lines: Array.from({ length: 3000 }, (_, i) => String(i)) } }
    const capped = await call(h, 'read', { console: '1', lines: 99999 }, caller1)
    check(w.ops.at(-1).lines === 2000 && capped.data.lines.length === 2000, '--lines is capped at 2000')
    check((await call(h, 'read', { console: 'srv:1' })).error.code === 'ssh_protected', 'read of a profile console: ssh_protected')
    w.running.delete('p1')
    check((await call(h, 'read', { console: '1' }, caller1)).error.code === 'not_running', 'read without a pty: not_running')
  }
  // status, note, notify
  {
    const w = fakeWorld()
    const h = makeHandlers(w)
    const set = await call(h, 'status', { text: '  corriendo\ntests ' + 'x'.repeat(200) }, caller1)
    check(set.ok && w.ops.at(-1).kind === 'setStatusLine' && w.ops.at(-1).paneId === 'p1' && w.ops.at(-1).text.length === 120 && w.ops.at(-1).text.startsWith('corriendo tests x'), 'status "<text>" sets the caller line, one line, max 120')
    h.onPtySpawn('p1')
    check(w.ops.at(-1).kind === 'setStatusLine' && w.ops.at(-1).text === null, 'a restart (new pty) clears the line')
    await call(h, 'status', { text: 'otra' }, caller1)
    h.onPtyExit('p1')
    check(w.ops.at(-1).text === null && w.ops.at(-1).paneId === 'p1', 'closing the console (pty exit) clears it too')
    const n = w.ops.length
    h.onPtySpawn('p2')
    check(w.ops.length === n, 'a console without a line is left alone')
    w.states.p1 = { paneId: 'p1', state: 'idle', precise: true }
    const get = await call(h, 'status', {}, caller1)
    check(get.ok && get.data.state === 'idle' && get.data.statusLine === 'corriendo tests', 'status without arguments shows state and line of self')
    check((await call(h, 'status', {}, null)).error.code === 'bad_request', 'status from outside without --console is bad_request')
    await call(h, 'status', { clear: true, console: '2' }, caller1)
    check(w.ops.at(-1).paneId === 'p2' && w.ops.at(-1).text === null, 'status --clear --console clears another console')

    const note = await call(h, 'note', { text: 'esperando\nCI', taskState: 'review' }, caller1)
    check(note.ok && w.ops.at(-1).kind === 'setNote' && w.ops.at(-1).workspaceId === 'w1' && w.ops.at(-1).note === 'esperando CI' && w.ops.at(-1).taskState === 'review', 'note sets the caller workspace note and task state')
    await call(h, 'note', { clear: true, workspace: 'srv' })
    check(w.ops.at(-1).workspaceId === 'w2' && w.ops.at(-1).note === null && w.ops.at(-1).taskState === null, 'note --clear clears both')
    check((await call(h, 'note', { taskState: 'blocked' }, caller1)).error.code === 'bad_request', 'an unknown task state is bad_request')

    for (let i = 0; i < 10; i++) check((await call(h, 'notify', { text: `n${i}` }, caller1)).ok, `notify ${i + 1} of 10 in a minute passes`)
    const eleventh = await call(h, 'notify', { text: 'n11' }, caller1)
    check(eleventh.error.code === 'rate_limited', 'the 11th notify in a minute: rate_limited')
    check((await call(h, 'notify', { text: 'otra consola' }, { ...caller1, paneId: 'p2' })).ok, 'the budget is per console')
    check((await call(h, 'notify', { text: 'externo', title: 'T'.repeat(90), local: true }, null)).ok, 'the master token has its own budget')
    const ext = w.notices.at(-1)
    check(ext.paneId === null && ext.local === true && ext.title.length === 80, 'notify --local from outside: no pane, title clipped to 80')
    const first = w.notices[0]
    check(first.title === 'SnAgentsOS' && first.body === 'n0' && first.local === false && first.paneId === 'p1', 'default title is the product name; remote unless --local')
    check(w.ops.some((o) => o.kind === 'attention' && o.paneId === 'p1'), 'notify marks the calling console with attention')
    check((await call(h, 'notify', { text: '   ' }, { ...caller1, paneId: 'p3' })).error.code === 'bad_request', 'an empty notify is bad_request')
  }
}

async function waitChecks() {
  // An idle agent with no recent turn returns at once.
  {
    const w = fakeWorld()
    const h = makeHandlers(w)
    w.states.p3 = { paneId: 'p3', state: 'idle', precise: true, stateSince: Date.now() - 50 }
    const t0 = Date.now()
    const r = await call(h, 'wait', { console: '3' }, caller1)
    check(r.ok && r.data.state === 'idle' && r.data.precise === true && Date.now() - t0 < 100, 'already idle, no working in the last seconds, no pending submit: returns at once')
  }
  // Working -> done: settles after settleMs in done.
  {
    const w = fakeWorld()
    const h = makeHandlers(w)
    w.states.p3 = { paneId: 'p3', state: 'working', precise: true, stateSince: Date.now() }
    h.onStatus(w.states.p3)
    let done = null
    const p = call(h, 'wait', { console: '3' }, caller1).then((r) => { done = r })
    await sleep(80)
    check(done === null && h.waiterCount === 1, 'while working the wait blocks')
    w.states.p3 = { paneId: 'p3', state: 'done', precise: true, stateSince: Date.now() }
    h.onStatus(w.states.p3)
    await sleep(60)
    check(done === null, 'it does not return before the settle time in done')
    await p
    check(done.ok && done.data.state === 'done' && h.waiterCount === 0, 'it returns after the settle time in done')
  }
  // send --enter then wait: never returns before the turn starts.
  {
    const w = fakeWorld()
    const h = makeHandlers(w)
    w.states.p3 = { paneId: 'p3', state: 'idle', precise: true, stateSince: Date.now() - 5000 }
    h.onStatus(w.states.p3)
    w.pty.lastSubmit.p3 = Date.now()
    let done = null
    const p = call(h, 'wait', { console: '3' }, caller1).then((r) => { done = r })
    await sleep(150)
    check(done === null, 'a submit with Enter and no transition yet: still busy (idle does not count)')
    w.states.p3 = { paneId: 'p3', state: 'working', precise: true, stateSince: Date.now() }
    h.onStatus(w.states.p3)
    await sleep(200)
    check(done === null, 'the turn started: still waiting')
    w.states.p3 = { paneId: 'p3', state: 'done', precise: true, stateSince: Date.now() }
    h.onStatus(w.states.p3)
    await p
    check(done.ok && done.data.state === 'done' && !done.data.noTurnObserved, 'returns only after the turn started and ended')
  }
  // noTurnObserved
  {
    const w = fakeWorld()
    const h = makeHandlers(w)
    w.states.p3 = { paneId: 'p3', state: 'idle', precise: true, stateSince: Date.now() - 5000 }
    h.onStatus(w.states.p3)
    w.pty.lastSubmit.p3 = Date.now()
    const t0 = Date.now()
    const r = await call(h, 'wait', { console: '3' }, caller1)
    check(r.ok && r.data.noTurnObserved === true && r.data.state === 'idle' && Date.now() - t0 >= 250, 'no transition after the submit within the window: noTurnObserved')
  }
  // A real question: action precise returns.
  {
    const w = fakeWorld()
    const h = makeHandlers(w)
    w.states.p3 = { paneId: 'p3', state: 'action', precise: true, reason: 'permission', stateSince: Date.now() - 1000 }
    const r = await call(h, 'wait', { console: '3' }, caller1)
    check(r.ok && r.data.state === 'action' && r.data.precise === true, 'a pending question returns with action + precise')
  }
  // Shell: quiet output.
  {
    const w = fakeWorld()
    const h = makeHandlers(w)
    w.pty.lastOutput.p2 = Date.now()
    const t0 = Date.now()
    const r = await call(h, 'wait', { console: '2', quietMs: 150 }, caller1)
    check(r.ok && r.data.state === null && Date.now() - t0 >= 140, 'a shell returns after --quiet-ms without output')
  }
  // Timeout, exit, self, cancel, 32 waiters.
  {
    const w = fakeWorld()
    const h = makeHandlers(w)
    w.states.p3 = { paneId: 'p3', state: 'working', precise: true, stateSince: Date.now() }
    const r = await call(h, 'wait', { console: '3', timeout: 0.2 }, caller1)
    check(!r.ok && r.error.code === 'timeout' && r.data.state === 'working' && r.data.waitedMs >= 190, '--timeout expires: timeout (exit 124) with state and waitedMs')
    const pending = call(h, 'wait', { console: '3' }, caller1)
    await sleep(30)
    h.onPtyExit('p3')
    const ex = await pending
    check(!ex.ok && ex.error.code === 'exited' && h.waiterCount === 0, 'the console exits: exited (exit 3)')
    check((await call(h, 'wait', { console: 'self' }, caller1)).error.code === 'bad_request', 'wait self: bad_request')
    w.running.delete('p2')
    check((await call(h, 'wait', { console: '2' }, caller1)).error.code === 'not_running', 'wait on a stopped console: not_running')
    const ac = new AbortController()
    const cancelled = call(h, 'wait', { console: '3' }, caller1, ac.signal)
    await sleep(30)
    check(h.waiterCount === 1, 'the waiter is registered')
    ac.abort()
    await cancelled
    check(h.waiterCount === 0, 'a client that goes away frees its waiter')
    const many = []
    const acs = []
    for (let i = 0; i < 32; i++) { const a = new AbortController(); acs.push(a); many.push(call(h, 'wait', { console: '3', timeout: 30 }, caller1, a.signal)) }
    await sleep(30)
    check(h.waiterCount === 32, '32 waits at once are accepted')
    const busy = await call(h, 'wait', { console: '3' }, caller1)
    check(!busy.ok && busy.error.code === 'busy', 'the 33rd gets busy')
    acs.forEach((a) => a.abort())
    await Promise.all(many)
    check(h.waiterCount === 0, 'all of them released')
  }
}

// --- J. cliEntry ---------------------------------------------------------------

async function cliEntryChecks() {
  const C = load('src/main/cli/cliEntry.ts')
  const p = (s) => C.parseArgs(s)
  check(p([]).command === 'help' && p(['ls', '--json']).flags.json === true, 'no command is help; --json is a global flag')
  const sp = p(['spawn', 'codex', '--prompt', 'revisa el diff', '-w', 'api', '--focus', '--no-profile'])
  check(sp.command === 'spawn' && sp.positionals[0] === 'codex' && sp.flags.prompt === 'revisa el diff' && sp.flags.workspace === 'api' && sp.flags.focus === true && sp.flags['no-profile'] === true, 'spawn flags, -w alias')
  check(p(['read', '2', '--lines=20']).flags.lines === '20' && p(['wait', 'api:2', '--idle', '--timeout', '110']).flags.timeout === '110', '--flag=value and --flag value')
  const usage = (argv) => { try { p(argv); return null } catch (e) { return e.message } }
  check(/unknown command/.test(usage(['frobnicate'])) && /unknown option/.test(usage(['ls', '--nope'])) && /needs a value/.test(usage(['ls', '--workspace'])) && /does not apply/.test(usage(['ls', '--enter'])), 'usage errors: unknown command, option, missing value, foreign flag')

  const io = (files = {}, stdin = '') => ({ readFile: (f) => { const k = Object.keys(files).find((x) => f.endsWith(x)); if (!k) throw new Error('ENOENT'); return files[k] }, readStdin: async () => stdin, cwd: () => tmpRoot })
  const b = (argv, i = io()) => C.buildCall(C.parseArgs(argv), i)
  const send = await b(['send', '2', '-'], io({}, '\uFEFFlinea 1\nlinea 2\n'))
  check(send.method === 'send' && send.params.console === '2' && send.params.text === 'linea 1\nlinea 2\n', 'send - reads stdin (BOM stripped) in the client')
  const file = await b(['send', 'api:2', '--file', 'notes.md', '--enter'], io({ 'notes.md': 'contenido "con comillas"' }))
  check(file.params.text === 'contenido "con comillas"' && file.params.enter === true, 'send --file is read by the client')
  check((await b(['send', '2', 'hola', 'mundo'])).params.text === 'hola mundo', 'unquoted words are joined')
  const pf = await b(['spawn', 'claude', '--prompt-file', 'task.md'], io({ 'task.md': 'arregla el login' }))
  check(pf.params.prompt === 'arregla el login' && pf.params.agent === 'claude', 'spawn --prompt-file is read by the client')
  const ps = await b(['spawn', 'claude', '--prompt', '-'], io({}, 'desde stdin'))
  check(ps.params.prompt === 'desde stdin', 'spawn --prompt - reads stdin')
  check((await b(['open', '--path', 'sub'])).params.path === path.resolve(tmpRoot, 'sub'), 'open --path is made absolute in the client')
  check((await b(['note', 'esperando CI', '--task-state', 'review'])).params.taskState === 'review' && (await b(['status', '--clear'])).params.clear === true, 'note and status params')
  check((await b(['help', '--agent'])) === null, 'help needs no server')

  // run(): a missing --prompt-file fails in the client with exit 2, never reaching main.
  const out = [], err = []
  let sent = 0
  const deps = (over = {}) => ({ io: io(), env: {}, out: (s) => out.push(s), err: (s) => err.push(s), connect: () => ({ endpoint: 'x', token: 't', console: true }), send: async () => { sent++; return { ok: true, data: {} } }, appVersion: '2.0.0', ...over })
  check((await C.run(['spawn', 'claude', '--prompt-file', 'missing.md'], deps())) === 2 && sent === 0 && /cannot read prompt file/.test(err.at(-1)), '--prompt-file with a missing path: exit 2 in the client, nothing sent')
  out.length = 0
  check((await C.run(['spawn', 'claude', '--prompt-file', 'missing.md', '--json'], deps())) === 2 && out.length === 1 && JSON.parse(out[0]).error.code === 'bad_request', '--json usage error: one JSON line')
  out.length = 0
  const okRes = { ok: true, data: { workspaces: [] } }
  check((await C.run(['ls', '--json'], deps({ send: async () => okRes }))) === 0 && out.length === 1 && out[0] === JSON.stringify(okRes) && !out[0].includes('\n'), '--json success: exactly one line of JSON')
  const exitOf = async (code) => C.run(['send', '2', 'x'], deps({ send: async () => ({ ok: false, error: { code, message: code } }) }))
  const codes = { bad_request: 2, not_found: 3, not_running: 3, exited: 3, ambiguous: 4, desktop_unavailable: 5, unauthorized: 6, ssh_protected: 7, multiline_unsafe: 7, rate_limited: 7, disabled: 7, forbidden: 7, timeout: 124, internal: 1 }
  for (const [code, exit] of Object.entries(codes)) check((await exitOf(code)) === exit, `error ${code} exits ${exit}`)
  check((await C.run(['ping'], deps({ connect: () => { throw new C.AppUnavailable('SnAgentsOS is not running') } }))) === 5 && /not running/.test(err.at(-1)), 'no app: exit 5 with "SnAgentsOS is not running"')
  out.length = 0
  check((await C.run(['help', '--agent'], deps())) === 0 && /120 s/.test(out.join('\n')) && out.join('\n').includes('snaos 2.0.0'), 'help --agent prints the versioned guide with the 120 s Bash note')

  // resolveConnection: env first, then --runtime; a dead pid means not running.
  const rt = JSON.stringify({ version: 1, pid: 4242, appVersion: '2.0.0', startedAt: 1, transport: { kind: 'named-pipe', endpoint: '\\\\.\\pipe\\m' }, token: 'm'.repeat(64) })
  const conn = C.resolveConnection({ runtime: 'r.json' }, { SNAOS_CTL_ENDPOINT: '\\\\.\\pipe\\c', SNAOS_CTL_TOKEN: 'c'.repeat(64) }, () => rt, () => true)
  check(conn.console === true && conn.token === 'c'.repeat(64), 'inside a console the console token wins over --runtime')
  const viaRt = C.resolveConnection({ runtime: 'r.json' }, {}, () => rt, () => true)
  check(viaRt.console === false && viaRt.token === 'm'.repeat(64) && viaRt.endpoint === '\\\\.\\pipe\\m', 'outside a console --runtime gives the master token')
  const dead = (() => { try { C.resolveConnection({ runtime: 'r.json' }, {}, () => rt, () => false); return null } catch (e) { return e } })()
  check(dead instanceof C.AppUnavailable && /not running/.test(dead.message), 'a runtime.json with a dead pid: not running')
  const missing = (() => { try { C.resolveConnection({ runtime: 'nope.json' }, {}, () => { throw new Error('ENOENT') }); return null } catch (e) { return e } })()
  check(missing instanceof C.AppUnavailable, 'no runtime.json: not running')
  check(C.pidAlive(process.pid) === true && C.pidAlive(0) === false, 'pidAlive')
  check(C.defaultRuntimePath({ APPDATA: 'C:\\AD' }, 'win32') === 'C:\\AD\\snagentsos\\runtime.json', 'default runtime path on Windows')
  check(C.defaultRuntimePath({ XDG_CONFIG_HOME: '/x/cfg' }, 'linux') === '/x/cfg/snagentsos/runtime.json' && C.defaultRuntimePath({}, 'darwin', () => '/Users/u') === '/Users/u/Library/Application Support/snagentsos/runtime.json', 'default runtime path on Linux and macOS, POSIX separators on any host')
  check(/spawned console 4/.test(C.formatHuman('spawn', { paneId: 'p', index: 4, promptDelivery: 'gate' })) && C.formatHuman('wait', { state: 'idle', precise: true, noTurnObserved: true }) === 'idle (no turn observed)', 'human output')
}

// --- K. CliService end to end ------------------------------------------------------

function makeService(dataDir, extra = {}) {
  const { CliService } = load('src/main/cli/CliService.ts', { require: (id) => (id === 'electron' ? {} : require(id)) })
  const world = fakeWorld()
  // A fake WebContents: the bus ops go to the world's renderer fake, results come back on onResult.
  let service
  const sender = {
    isDestroyed: () => false,
    send: (channel, cmd) => {
      if (channel !== 'remote:controlCmd') return
      void world.bus.request(cmd.action.op).then((res) => service.bus.onResult({ id: cmd.id, ok: res.ok, ...(res.ok ? { data: res.data } : { error: res.error }) }))
    },
  }
  const routed = []
  service = new CliService({
    dataDir: () => dataDir,
    appVersion: '2.0.0',
    execPath: process.execPath,
    cliPath: path.join(dataDir, 'cli.js'),
    portable: false,
    getSender: () => sender,
    pty: world.pty,
    status: { ...world.status, notifyCustom: () => true },
    config: () => world.config,
    routeCustom: (n) => routed.push(n),
    // Never the real ~/.claude: the skill refresh at init reads this tree.
    skillEnv: { CLAUDE_CONFIG_DIR: path.join(dataDir, 'claude') },
    handlerOverrides: { timing: { settleMs: 50, recentWorkingMs: 100, noTurnMs: 200, tickMs: 20 } },
    ...extra,
  })
  return { service, world, routed }
}

async function serviceChecks() {
  const C = load('src/main/cli/cliEntry.ts')
  const dataDir = tmp('service-data')
  const { service, world, routed } = makeService(dataDir, { registry: { read: async () => '', write: async () => { throw new Error('never in tests') }, broadcast: async () => {} } })
  service.init()
  const shim = path.join(dataDir, 'bin', win ? 'snaos.cmd' : 'snaos')
  check(fs.existsSync(shim), 'init writes the shim under dataDir()/bin')
  check(Object.keys(service.envFor('pty-p0', 'p0', 'w1')).length === 0, 'CLI off: a new pty gets no SNAOS_CTL_* env')
  await service.setEnabled(true)
  const runtime = JSON.parse(fs.readFileSync(path.join(dataDir, 'runtime.json'), 'utf8'))
  check(service.running && runtime.pid === process.pid && runtime.transport.endpoint === service.transport.endpoint && /^[0-9a-f]{64}$/.test(runtime.token), 'CLI on: server up and runtime.json with endpoint and master token')
  const env1 = service.envFor('pty-p1', 'p1', 'w1')
  const env2 = service.envFor('pty-p2', 'p2', undefined)
  check(env1.SNAOS_CTL_TOKEN !== env2.SNAOS_CTL_TOKEN && env1.SNAOS_CTL_TOKEN !== runtime.token && env1.SNAOS_CTL_ENDPOINT === runtime.transport.endpoint && env1.SNAOS_CLI === shim && env1.SNAOS_WORKSPACE_ID === 'w1', 'each console gets its own token (never the master), the endpoint, the shim and its workspace')
  const deps = (env, out, err) => ({ io: { readFile: (f) => fs.readFileSync(f, 'utf8'), readStdin: async () => '', cwd: () => tmpRoot }, env, out: (s) => out.push(s), err: (s) => err.push(s), appVersion: '2.0.0' })
  {
    const out = [], err = []
    check((await C.run(['ping', '--json'], deps(env1, out, err))) === 0 && JSON.parse(out[0]).data.self === 'p1', 'snaos ping from a console answers and knows self')
  }
  {
    const out = [], err = []
    check((await C.run(['ls', '--json', '--runtime', path.join(dataDir, 'runtime.json')], deps({}, out, err))) === 0 && JSON.parse(out[0]).data.workspaces.length === 2, 'an external terminal with --runtime uses the master token')
  }
  {
    const out = [], err = []
    world.states.p3 = { paneId: 'p3', state: 'idle', precise: true, stateSince: Date.now() - 1000 }
    const code = await C.run(['send', '3', 'hola', '--enter'], deps(env1, out, err))
    check(code === 0 && world.pty.submits.at(-1).paneId === 'p3', 'send through the whole chain (client, pipe, server, bus, pty)')
  }
  {
    const out = [], err = []
    check((await C.run(['wait', 'self', '--idle'], deps(env1, out, err))) === 2, 'wait self exits 2')
    check((await C.run(['send', 'srv:1', 'x'], deps(env1, out, err))) === 7 && /Connection Profile/.test(err.at(-1)), 'ssh_protected exits 7')
    check((await C.run(['send', 'claude', 'x'], deps(env2, out, err))) === 0, 'a title from console 2')
  }
  {
    const out = [], err = []
    const code = await C.run(['notify', 'build', 'listo', '--title', 'CI'], deps(env1, out, err))
    check(code === 0 && routed.length === 1 && routed[0].kind === 'custom' && routed[0].body === 'build listo' && routed[0].paneId === 'p1', 'notify reaches the router as a custom notice from the caller')
  }
  // Ctrl+C during wait: the client goes away, the server frees the waiter.
  {
    world.states.p3 = { paneId: 'p3', state: 'working', precise: true, stateSince: Date.now() }
    const body = JSON.stringify({ v: 1, method: 'wait', params: { console: '3' } })
    const req = http.request({ socketPath: env1.SNAOS_CTL_ENDPOINT, method: 'POST', path: '/v1/rpc', headers: { Authorization: `Bearer ${env1.SNAOS_CTL_TOKEN}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } })
    req.on('error', () => {})
    req.end(body)
    await sleep(150)
    check(service.handlers.waiterCount === 1, 'a wait from the CLI is pending in main')
    req.destroy()
    await sleep(150)
    check(service.handlers.waiterCount === 0, 'Ctrl+C in the client (socket closed) releases the waiter in main')
  }
  // The pty exits: its token is revoked (401, exit 6 with the restart hint).
  service.sink.onExit('pty-p2', 'p2', 0, { current: true, natural: true })
  {
    const out = [], err = []
    check((await C.run(['ping'], deps(env2, out, err))) === 6 && /restart the console/.test(err.at(-1)), "a closed console's token gets 401: exit 6, restart the console")
  }
  // Off and on again: same endpoint, same tokens.
  await service.setEnabled(false)
  check(!service.running && !fs.existsSync(path.join(dataDir, 'runtime.json')), 'CLI off: no server and no runtime.json')
  check(Object.keys(service.envFor('pty-p9', 'p9', 'w1')).length === 0, 'CLI off: new consoles get nothing')
  {
    const out = [], err = []
    check((await C.run(['ping'], deps(env1, out, err))) === 5, 'CLI off: the console gets "not running" (exit 5)')
  }
  await service.setEnabled(true)
  {
    const out = [], err = []
    check((await C.run(['ping', '--json'], deps(env1, out, err))) === 0 && service.transport.endpoint === env1.SNAOS_CTL_ENDPOINT, 'on again: same endpoint, the old console token still works')
  }
  const ui = await service.uiState()
  check(ui.enabled && ui.running && ui.endpoint === service.transport.endpoint && !JSON.stringify(ui).includes(runtime.token) && !JSON.stringify(ui).includes(env1.SNAOS_CTL_TOKEN), 'the Settings state never carries a token')
  check((await service.setUserPath(true)) === false, 'a failing registry write reports false (and never touches the real HKCU)')
  check(service.skill('install').state === 'installed' && fs.existsSync(path.join(dataDir, 'claude', 'skills', 'snagentsos', 'SKILL.md')) && service.skill('remove').state === 'missing', 'the service skill ops use the injected CLAUDE_CONFIG_DIR')
  service.shutdown()
  check(!fs.existsSync(path.join(dataDir, 'runtime.json')), 'quit removes runtime.json')
  await sleep(50)
  const portable = makeService(tmp('service-portable'), { portable: true }).service
  check((await portable.setUserPath(true)) === false && (await portable.uiState()).portable === true, 'the portable never edits the user PATH')
}

// --- L. The shim, executed with the repo's Electron -----------------------------------

async function shimRunChecks() {
  const electronExe = win ? path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe') : path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron')
  if (!fs.existsSync(electronExe)) {
    console.log('skip: the repo Electron is not installed, shim run checks skipped')
    return
  }
  const dir = tmp('shim-run')
  const cliPath = path.join(dir, 'cli.js')
  buildSync({ entryPoints: [path.join(root, 'src/main/cli/cliEntry.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: cliPath, alias: { '@shared': path.join(root, 'src/shared') }, define: { __SNAOS_APP_VERSION__: '"2.0.0"' } })
  const { CtlServer } = load('src/main/cli/CtlServer.ts')
  const { CtlTokens, newToken } = load('src/main/cli/CtlTokens.ts')
  const master = newToken()
  const tokens = new CtlTokens(master)
  const endpoint = pipeName()
  const server = new CtlServer({ kind: win ? 'named-pipe' : 'unix', endpoint }, (t) => tokens.resolve(t), async (method, params) => ({ ok: true, data: { pong: true, appVersion: '2.0.0', self: null, echo: params } }))
  await server.start()
  const runtimePath = path.join(dir, 'runtime.json')
  fs.writeFileSync(runtimePath, JSON.stringify({ version: 1, pid: process.pid, appVersion: '2.0.0', startedAt: Date.now(), transport: { kind: win ? 'named-pipe' : 'unix', endpoint }, token: master }))
  const S = load('src/main/cli/shim.ts')
  const bin = path.join(dir, 'bin')
  const shim = S.writeShim(bin, { execPath: electronExe, cliPath, runtimePath })
  // A clean env: no SNAOS_* of whatever console runs the tests.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith('SNAOS_') && k.toUpperCase() !== 'ELECTRON_RUN_AS_NODE'))
  const runAsync = (file, args) => new Promise((resolve) => {
    const child = spawn(file, args, { env, windowsHide: true, timeout: 30000, shell: false, windowsVerbatimArguments: win })
    let stdout = '', stderr = ''
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
  // cmd /s /c "<line>": the outer quotes go, the line runs as typed in cmd.
  const cmdExe = process.env.ComSpec || 'cmd.exe'
  const viaShim = (file, args) => (win ? runAsync(cmdExe, ['/d', '/s', '/c', `""${file}" ${args.join(' ')}"`]) : runAsync('/bin/sh', [file, ...args]))
  try {
    const res = await viaShim(shim, ['ping', '--json'])
    check(res.status === 0 && JSON.parse(res.stdout.trim()).data.pong === true, 'the generated shim runs cli.js on the repo Electron (ELECTRON_RUN_AS_NODE) and pings the server')
    const accents = await viaShim(shim, ['send', '2', 'arreglá', 'ñandú', '--json'])
    check(accents.status === 0 && JSON.parse(accents.stdout.trim()).data.echo.text === 'arreglá ñandú', 'accents in arguments survive the shim')
    if (win) {
      const leak = await runAsync(cmdExe, ['/d', '/s', '/c', `"call "${shim}" ping & set ELECTRON_RUN_AS_NODE"`])
      check(leak.stdout.includes('pong') && !/ELECTRON_RUN_AS_NODE=1/.test(leak.stdout), 'after snaos, ELECTRON_RUN_AS_NODE is not left in the shell (setlocal)')
      // A user folder with an accent (C:\Users\Martín): cmd reads the batch in the
      // console code page, so the shim must switch to 65001 and restore it.
      const accented = path.join(dir, 'Martín Ñandú')
      const junction = spawnSync(cmdExe, ['/d', '/c', 'mklink', '/J', accented, path.dirname(electronExe)], { windowsHide: true })
      if (junction.status === 0) {
        try {
          const data = path.join(dir, 'Datos José')
          fs.mkdirSync(data, { recursive: true })
          const accCli = path.join(data, 'cli.js')
          fs.copyFileSync(cliPath, accCli)
          const accShim = S.writeShim(path.join(data, 'bin'), { execPath: path.join(accented, path.basename(electronExe)), cliPath: accCli, runtimePath })
          check(/chcp 65001/.test(fs.readFileSync(accShim, 'utf8')) && !/chcp/.test(fs.readFileSync(shim, 'utf8')), 'only a shim with non-ASCII paths switches the code page')
          const before = await runAsync(cmdExe, ['/d', '/s', '/c', '"chcp"'])
          const acc = await runAsync(cmdExe, ['/d', '/s', '/c', `"call "${accShim}" ping --json & chcp"`])
          const pong = acc.stdout.split(/\r?\n/).find((l) => l.startsWith('{'))
          check(!!pong && JSON.parse(pong).data.pong === true, 'a shim whose exe and cli.js live under accented folders still runs', acc)
          const cp = (s) => (s.match(/(\d+)\.?\s*$/m) ?? [])[1]
          check(cp(acc.stdout) === cp(before.stdout), 'the caller code page is restored after the shim', { before: before.stdout, after: acc.stdout })
          const accGone = S.writeShim(path.join(data, 'bin-gone'), { execPath: path.join(accented, 'missing.exe'), cliPath: accCli, runtimePath })
          const accClosed = await viaShim(accGone, ['ping'])
          check(accClosed.status === 5 && /not running/.test(accClosed.stderr), 'the accented shim still exits 5 when the exe is gone')
        } finally {
          spawnSync(cmdExe, ['/d', '/c', 'rmdir', accented], { windowsHide: true })
        }
      } else console.log('skip: could not create a junction, accented shim checks skipped')
    }
    const gone = S.writeShim(path.join(dir, 'bin-gone'), { execPath: path.join(dir, 'missing', 'SnAgentsOS.exe'), cliPath, runtimePath })
    const closed = await viaShim(gone, ['ping'])
    check(closed.status === 5 && /SnAgentsOS is not running/.test(closed.stderr), 'with the exe gone (closed portable) the shim exits 5 with the message')
    fs.writeFileSync(runtimePath, JSON.stringify({ version: 1, pid: 999999, appVersion: '2.0.0', startedAt: 1, transport: { kind: win ? 'named-pipe' : 'unix', endpoint }, token: master }))
    const deadPid = await viaShim(shim, ['ping'])
    check(deadPid.status === 5 && /not running/.test(deadPid.stderr), 'a runtime.json of a dead pid: exit 5')
  } finally {
    await server.stop()
  }
}

// --- M. PtyManager: tail, CLI env, workspace -----------------------------------------

function ptyChecks() {
  const procs = [], spawnCalls = []
  const impl = (shell, args, opts) => {
    spawnCalls.push({ shell, args, opts })
    const dataCbs = [], exitCbs = []
    const proc = { cols: opts.cols, rows: opts.rows, writes: [], onData: (cb) => dataCbs.push(cb), onExit: (cb) => exitCbs.push(cb), write: (d) => proc.writes.push(d), resize() {}, pause() {}, resume() {}, kill() { exitCbs.forEach((cb) => cb({ exitCode: 1 })) }, emit: (d) => dataCbs.forEach((cb) => cb(d)) }
    procs.push(proc)
    return proc
  }
  const userData = tmp('pty-userdata')
  const provided = []
  const { PtyManager } = load('src/main/pty/PtyManager.ts', {
    console: { ...console, warn() {} },
    require: (id) => (id === 'node-pty' ? { spawn: impl } : id === 'electron' ? { app: { getPath: () => userData } } : require(id)),
    setInterval: () => 0,
    clearInterval() {},
  })
  const bin = path.join(tmp('pty-bin'), 'bin')
  const pm = new PtyManager(() => null, (ptyId, paneId, cwd, workspaceId) => { provided.push({ ptyId, paneId, workspaceId }); return { SNAOS_CTL_TOKEN: 'tok', SNAOS_CLI: path.join(bin, 'snaos.cmd') } })
  pm.setEngine({ snapshotMode: 'off' })
  const { ptyId } = pm.spawn({ paneId: 'pane-1', workspaceId: 'ws-9', cols: 80, rows: 24, shell: process.execPath })
  const env = spawnCalls[0].opts.env
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path')
  check(provided[0].workspaceId === 'ws-9' && provided[0].paneId === 'pane-1' && provided[0].ptyId === ptyId, 'the env provider receives the spawn workspace (SNAOS_WORKSPACE_ID)')
  check(env[pathKey].split(path.delimiter)[0] === bin && env.SNAOS_CTL_TOKEN === 'tok', 'the CLI bin folder goes first in PATH')
  procs[0].emit('\x1b[1mhola\x1b[0m\r\n')
  const before = JSON.stringify(procs[0].writes)
  check(pm.tail('pane-1') === '\x1b[1mhola\x1b[0m\r\n' && JSON.stringify(procs[0].writes) === before, 'tail returns the raw ring without side effects')
  check(pm.tail('nope') === null, 'tail of a pane without a pty is null')
}

async function main() {
  try {
    refChecks()
    ansiChecks()
    tokenChecks()
    envChecks()
    runtimeAndShimChecks()
    await userPathChecks()
    skillChecks()
    await noticeChecks()
    await serverChecks()
    await handlerChecks()
    await waitChecks()
    await cliEntryChecks()
    await serviceChecks()
    await shimRunChecks()
    ptyChecks()
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
    if (sockRoot) fs.rmSync(sockRoot, { recursive: true, force: true })
  }
  console.log(`PASS: ${checks} cli checks (refs, ANSI, tokens, env, runtime.json, shim static and executed, user PATH, skill, custom notify, CtlServer, handlers, wait, cliEntry, CliService end to end, pty tail)`)
}
main().catch((err) => {
  console.error(err)
  process.exit(1)
})
