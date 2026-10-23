// snaos CLI suite (E8-FR-12..22, R30-11): addresses (ctlRefs), ANSI fallback,
// console tokens, cleanEnv, runtime.json, the shim (static and executed with
// the repo's Electron against a test server), user PATH with an injected
// registry, the skill for Claude and Codex in a temp CLAUDE_CONFIG_DIR and
// CODEX_HOME (and the cli:skill payload), `notify` custom notices
// (Discord, ntfy, router, native), CtlServer over a real temp pipe (401, 403,
// 413, caller from the token), every handler (ls, open, spawn, send, read,
// wait incl. noTurnObserved / timeout / cancel / 32 waiters, status, notify
// rate, note; app 2.3.0: chat and peek over the chat fixtures, kill, restart,
// rename, ws, notes; 4b: usage, account ls|status|use over the AccountService
// adapter, never a token or an email), cliEntry (parser, subcommands, stdin, --file, --json,
// exit codes incl. 8, dead pid) and CliService end to end (a real WsNoteStore
// and the fixture transcripts through the pipe). Same esbuild + vm harness as test-status.cjs.
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
  // app 2.3.0: Markdown notes by id or exact title, never an index.
  const notes = [
    { id: 'n-aaaa', title: 'Plan', updatedAt: 3, size: 10, rev: 'r1' },
    { id: 'n-bbbb', title: 'Ideas', updatedAt: 2, size: 5, rev: 'r1' },
    { id: 'n-cccc', title: 'ideas', updatedAt: 1, size: 5, rev: 'r1' },
    { id: 'n-dddd', title: '', updatedAt: 0, size: 0, rev: 'r1' },
  ]
  const n = (ref) => R.resolveNoteRef(notes, ref)
  check(n('n-bbbb').ok && n('n-bbbb').note.title === 'Ideas', 'a note by id')
  check(n('  PLAN ').ok && n('  PLAN ').note.id === 'n-aaaa', 'a note by exact title, case-insensitive, trimmed')
  check(!n('ideas').ok && n('ideas').code === 'ambiguous' && /n-bbbb/.test(n('ideas').message) && /n-cccc/.test(n('ideas').message), 'a repeated title is ambiguous and lists the ids')
  check(n('').code === 'bad_request' && n('Plan B').code === 'not_found' && n('1').code === 'not_found', 'empty is bad_request; unknown (and an index) is not_found')
  // The stored title drops Markdown marks (noteTitle): `fix_login` is listed as `fixlogin`.
  const W = load('src/shared/ws-notes.ts')
  const marked = [{ id: 'n-eeee', title: W.noteTitle('# fix_login `api`'), updatedAt: 0, size: 0, rev: 'r1' }]
  const m = (ref) => R.resolveNoteRef(marked, ref)
  check(marked[0].title === 'fixlogin api' && m('fix_login `api`').ok && m('# FIX_login `api`').ok && m('fixlogin api').ok && m('fix_login').code === 'not_found', 'a title with Markdown marks resolves as written (cleaned like the stored title)')
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
  const env = { CLAUDE_CONFIG_DIR: tmp('claude'), CODEX_HOME: tmp('codex') }
  const dir = path.join(env.CLAUDE_CONFIG_DIR, 'skills', 'snagentsos')
  const cdir = path.join(env.CODEX_HOME, 'skills', 'snagentsos')
  check(K.skillDir('claude', env) === dir, 'the Claude skill lives under CLAUDE_CONFIG_DIR/skills/snagentsos')
  check(K.skillDir('codex', env) === cdir, 'the Codex skill lives under CODEX_HOME/skills/snagentsos')
  check(K.skillStatus('claude', '2.0.0', env).state === 'missing' && K.skillStatus('claude', '2.0.0', env).target === 'claude', 'not installed by default (never installs on its own)')
  check(K.skillStatus('codex', '2.0.0', env).state === 'missing' && K.skillStatus('codex', '2.0.0', env).target === 'codex', 'Codex: not installed by default and the status carries its target')
  const none = K.refreshSkillOnStartup('2.0.0', env)
  check(none.length === 2 && none.every((s) => s.state === 'missing') && !fs.existsSync(dir) && !fs.existsSync(cdir), 'the startup refresh never installs, for either agent')
  const st = K.installSkill('claude', '2.0.0', env)
  const md = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')
  check(st.state === 'installed' && st.version === '2.0.0' && st.target === 'claude', 'install writes it and reports installed v2.0.0')
  check(md.startsWith('---\nname: snagentsos\ndescription: ') && md.includes('<!-- managed-by: snagentsos v2.0.0 -->') && md.includes('snaos help --agent'), 'SKILL.md has the front matter, our marker and the pointer to the guide')
  check(K.skillStatus('codex', '2.0.0', env).state === 'missing' && !fs.existsSync(cdir), 'installing for Claude never touches the Codex folder')
  const cst = K.installSkill('codex', '2.0.0', env)
  const cmd = fs.readFileSync(path.join(cdir, 'SKILL.md'), 'utf8')
  check(cst.state === 'installed' && cst.version === '2.0.0' && cst.target === 'codex' && cst.path === cdir, 'Codex: install writes <CODEX_HOME>/skills/snagentsos/SKILL.md')
  check(cmd === md, 'both agents get the same stub')
  // Codex needs name + description in a one-line YAML front matter (name <= 64, description <= 1024).
  const fm = cmd.split('\n')
  const nameLine = fm[1], descLine = fm[2]
  check(fm[0] === '---' && fm[3] === '---' && /^name: [a-z0-9-]{1,64}$/.test(nameLine) && descLine.startsWith('description: ') && descLine.length - 'description: '.length <= 1024, 'the front matter is name + one-line description within the Codex limits')
  check(!/: |\s#/.test(descLine.slice('description: '.length)) && !/^description: ["'|>\[{&*!%@`]/.test(descLine), 'the description parses as a plain YAML scalar (no ": ", no " #", no leading indicator)')
  check(['mira que esta haciendo la consola', 'anota esto en las notas del workspace', 'cuanto uso me queda', 'cambia de cuenta de claude'].every((t) => descLine.includes(`"${t}"`)) && /usage/.test(descLine) && /Claude account/.test(descLine), 'the description triggers on observing consoles, notes, usage and the Claude account')
  check(K.skillStatus('claude', '2.1.0', env).state === 'outdated' && K.skillStatus('codex', '2.1.0', env).state === 'outdated', 'another app version reads as outdated, per agent')
  const ref = K.refreshSkillOnStartup('2.1.0', env)
  check(ref[0].target === 'claude' && ref[0].state === 'installed' && ref[1].target === 'codex' && ref[1].state === 'installed', 'the startup refresh rewrites both agents')
  check(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8').includes('v2.1.0') && fs.readFileSync(path.join(cdir, 'SKILL.md'), 'utf8').includes('v2.1.0'), 'after an update both stubs carry the new version')
  check(K.removeSkill('claude', '2.1.0', env).state === 'missing' && !fs.existsSync(dir) && fs.existsSync(cdir), 'remove deletes only the selected agent\'s folder')
  check(K.repairSkill('codex', '2.2.0', env).version === '2.2.0' && K.skillStatus('codex', '2.2.0', env).state === 'installed', 'Codex: repair rewrites an outdated stub')
  check(K.removeSkill('codex', '2.2.0', env).state === 'missing' && !fs.existsSync(cdir), 'Codex: remove deletes our folder')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: snagentsos\n---\nmine')
  check(K.skillStatus('claude', '2.0.0', env).state === 'foreign', 'a folder without our marker is foreign')
  check(K.removeSkill('claude', '2.0.0', env).error === 'foreign' && fs.existsSync(path.join(dir, 'SKILL.md')), 'remove never deletes a foreign folder')
  check(K.installSkill('claude', '2.0.0', env).error === 'foreign' && fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8').endsWith('mine'), 'install never overwrites a foreign folder')
  check(K.repairSkill('claude', '2.0.0', env).state === 'foreign', 'repair leaves a foreign folder alone')
  check(K.refreshSkillOnStartup('2.5.0', env)[0].state === 'foreign' && fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8').endsWith('mine'), 'the startup refresh leaves a foreign folder alone')
  fs.mkdirSync(cdir, { recursive: true })
  fs.writeFileSync(path.join(cdir, 'SKILL.md'), '---\nname: snagentsos\n---\ncodex mine')
  check(K.skillStatus('codex', '2.0.0', env).state === 'foreign' && K.removeSkill('codex', '2.0.0', env).error === 'foreign' && K.installSkill('codex', '2.0.0', env).error === 'foreign' && fs.readFileSync(path.join(cdir, 'SKILL.md'), 'utf8').endsWith('codex mine'), 'Codex: a foreign folder is never overwritten or removed')
  // Without CODEX_HOME the Codex folder is ~/.codex/skills/snagentsos (path only: nothing is read or written).
  check(K.skillDir('codex', {}) === path.join(os.homedir(), '.codex', 'skills', 'snagentsos') && K.skillDir('claude', {}) === path.join(os.homedir(), '.claude', 'skills', 'snagentsos'), 'default folders are ~/.codex and ~/.claude')
  check(K.skillStub('9.9.9').includes('If a command says SnAgentsOS is not running'), 'the stub tells the agent to stop when the app is down')
  // cli:skill payload: { op, target }, the old bare op string means Claude, an unknown target never writes.
  const P = K.parseSkillRequest
  const same = (a, b) => a.op === b.op && a.target === b.target
  check(same(P({ op: 'install', target: 'codex' }), { op: 'install', target: 'codex' }) && same(P({ op: 'remove', target: 'claude' }), { op: 'remove', target: 'claude' }), 'the payload carries op and target')
  check(same(P('repair'), { op: 'repair', target: 'claude' }) && same(P({ op: 'install' }), { op: 'install', target: 'claude' }) && same(P({ op: 'install', target: null }), { op: 'install', target: 'claude' }), 'the old bare op and a missing target mean claude')
  check(same(P({ op: 'install', target: 'gemini' }), { op: 'status', target: 'claude' }) && same(P({ op: 'install', target: 7 }), { op: 'status', target: 'claude' }), 'an unknown target downgrades to a read-only status')
  check(same(P({ op: 'format', target: 'codex' }), { op: 'status', target: 'codex' }) && same(P(undefined), { op: 'status', target: 'claude' }) && same(P(42), { op: 'status', target: 'claude' }), 'an unknown op, undefined or junk is status')
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
      if (op.kind === 'createWorkspace') return { ok: true, data: { workspaceId: 'w-new', index: 3 } }
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
    async submitToPane(ptyId, paneId, text, enter, origin, readyFor, userGate) { pty.submits.push({ ptyId, paneId, text, enter, origin, readyFor, userGate }); return pty.submitResult },
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
    const fresh = ['chat', 'peek', 'kill', 'restart', 'rename', 'ws.new', 'ws.rename', 'ws.close', 'ws.fav', 'notes.ls', 'notes.get', 'notes.new', 'notes.set', 'notes.append', 'notes.rm', 'notes.open', 'usage', 'account.ls', 'account.status', 'account.use']
    const passed = []
    for (const method of fresh) if ((await rpcRaw(endpoint, { token: master, body: { v: 1, method, params: {} } })).json.ok) passed.push(method)
    check(passed.length === fresh.length && fresh.every((m) => seen.some((s) => s.method === m)), 'every app 2.3.0 method (4b usage and account.* included) passes the server validation', passed)
    check((await rpcRaw(endpoint, { token: master, body: { v: 1, method: 'account.rm', params: {} } })).json.error.code === 'bad_request', 'an account method the protocol does not have (account.rm): bad_request')
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
    check(w.pty.submits[0].origin === 'auto', 'v2.3: snaos send writes with origin auto (it never acknowledges attention)')
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
    // A console waiting on its user (main's precise status): nothing is typed, with or without --enter.
    const n = w.pty.submits.length
    w.states.p3 = { paneId: 'p3', state: 'action', precise: true, provider: 'claude', pendingCount: 1 }
    for (const params of [{ text: '1', enter: true }, { text: '1' }, { text: '', enter: true }]) {
      const res = await call(h, 'send', { console: '3', ...params }, caller1)
      check(!res.ok && res.error.code === 'awaiting_user' && w.pty.submits.length === n, `send ${JSON.stringify(params)} to a permission menu: awaiting_user, nothing written`)
    }
    w.states.p3 = { paneId: 'p3', state: 'working', precise: true, provider: 'claude', pendingCount: 1 }
    check((await call(h, 'send', { console: '3', text: 'y', enter: true }, caller1)).error?.code === 'awaiting_user' && w.pty.submits.length === n, 'an open request (pendingCount) while working: awaiting_user')
    w.states.p3 = { paneId: 'p3', state: 'action', precise: false, provider: 'claude', pendingCount: 1 }
    check((await call(h, 'send', { console: '3', text: 'sigue', enter: true }, caller1)).ok && w.pty.submits.length === n + 1, 'a title-only action (SSH, WSL, cmd end of turn) still gets the text')
    w.states.p3 = { paneId: 'p3', state: 'idle', precise: true, provider: 'claude', pendingCount: 0 }
    check((await call(h, 'send', { console: '3', text: 'x', enter: true }, caller1)).ok, 'a precise idle agent gets it')
    check(w.pty.submits.at(-1).userGate === true && w.pty.submits.at(-1).readyFor === undefined, 'send opts into main\'s userGate (re-checked right before the deferred Enter)')
    // The menu opened while main typed the text: main dropped the Enter.
    w.pty.submitResult = { ok: false, error: 'enter_held' }
    let held = await call(h, 'send', { console: '3', text: 'x', enter: true }, caller1)
    check(!held.ok && held.error.code === 'awaiting_user' && /typed, not submitted/.test(held.error.message), 'a dropped Enter (enter_held): awaiting_user (exit 9), the text stays typed')
    w.pty.submitResult = { ok: false, error: 'awaiting_user' }
    held = await call(h, 'send', { console: '3', text: 'x', enter: true }, caller1)
    check(!held.ok && held.error.code === 'awaiting_user' && /nothing was typed/.test(held.error.message), "main's own refusal (awaiting_user) maps to awaiting_user")
    w.pty.submitResult = { ok: true }
    delete w.states.p3
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

// --- H/I (app 2.3.0). chat, peek, console and workspace control, notes ----------------

const FIX = path.join(root, 'scripts', 'fixtures', 'chat')
const claudeRec = (role, uuid, text) => JSON.stringify({ isSidechain: false, type: role, uuid, timestamp: '2026-10-01T10:00:00.000Z', message: role === 'user' ? { role: 'user', content: text } : { id: `m-${uuid}`, role: 'assistant', content: [{ type: 'text', text }] } })

/** An in-memory WsNoteStore: revs r1, r2..., `conflict` on a stale baseRev, writes yield so races show. */
function fakeNotes() {
  const docs = new Map()
  let rev = 0, ids = 0, clock = 1000
  const meta = (id, d) => ({ id, title: (d.text.split('\n').find((l) => l.trim()) ?? '').replace(/^#+\s*/, '').trim(), updatedAt: d.updatedAt, size: Buffer.byteLength(d.text), rev: d.rev })
  const put = (k, text) => docs.set(k, { text, rev: `r${++rev}`, updatedAt: ++clock })
  const api = {
    calls: [],
    interfere: null,
    seed(ws, id, text) { put(`${ws}/${id}`, text) },
    text(ws, id) { return docs.get(`${ws}/${id}`)?.text },
    async list(ws) { api.calls.push('list'); return { ok: true, notes: [...docs].filter(([k]) => k.startsWith(`${ws}/`)).map(([k, d]) => meta(k.slice(ws.length + 1), d)).sort((a, b) => b.updatedAt - a.updatedAt) } },
    async read({ workspaceId, noteId }) { const d = docs.get(`${workspaceId}/${noteId}`); return d ? { ok: true, note: { ...meta(noteId, d), text: d.text, path: `C:\\data\\notes\\${workspaceId}\\${noteId}.md` } } : { ok: false, error: 'not_found' } },
    async write({ workspaceId, noteId, text, baseRev }) {
      api.calls.push('write')
      const k = `${workspaceId}/${noteId}`
      if (!docs.has(k)) return { ok: false, error: 'not_found' }
      if (api.interfere) { const f = api.interfere; api.interfere = null; f() }
      const cur = docs.get(k)
      if (baseRev !== undefined && cur.rev !== baseRev) return { ok: false, error: 'conflict', current: { ...meta(noteId, cur), text: cur.text } }
      await sleep(3)
      put(k, text)
      return { ok: true, note: meta(noteId, docs.get(k)) }
    },
    async create({ workspaceId, text }) { api.calls.push('create'); const id = `n-${String(++ids).padStart(4, '0')}`; put(`${workspaceId}/${id}`, text ?? ''); return { ok: true, note: meta(id, docs.get(`${workspaceId}/${id}`)) } },
    async delete({ workspaceId, noteId }) { api.calls.push('delete'); return docs.delete(`${workspaceId}/${noteId}`) ? { ok: true } : { ok: false, error: 'not_found' } },
  }
  return api
}

async function moreHandlerChecks() {
  // chat: stateless transcript reads through a fake locate + the fixtures.
  {
    const w = fakeWorld()
    const locs = {
      p1: { ok: true, path: path.join(FIX, 'claude-session.jsonl'), provider: 'claude' },
      p3: { ok: true, path: path.join(FIX, 'codex-rollout.jsonl'), provider: 'codex' },
    }
    const located = []
    const svc = { chat: { locate: async (id) => { located.push(id); return locs[id] ?? { ok: false, reason: 'noTranscript' } } } }
    const h = makeHandlers(w, undefined, { services: () => svc })
    const all = await call(h, 'chat', { console: '1' }, caller1)
    check(all.ok && all.data.provider === 'claude' && all.data.turns === 3 && all.data.items[0].id === '56' && all.data.items[0].role === 'user' && all.data.nextCursor === null, 'chat: the last 3 turns of a Claude console (the whole fixture), oldest first, no older cursor')
    check(all.data.items.every((m) => m.blocks.every((b) => b.t !== 'thinking' && b.t !== 'toolResult')) && all.data.items.some((m) => m.blocks.some((b) => b.t === 'toolUse' && b.summary === 'npm test')), 'chat: tool calls stay, tool output and thinking only with their flags')
    check(!all.data.items.some((m) => m.role === 'tool'), 'chat: a tool row left without blocks is dropped')
    const one = await call(h, 'chat', { console: '1', turns: 1 }, caller1)
    check(JSON.stringify(one.data.items.map((m) => m.id)) === '["7724","8197"]' && one.data.turns === 1 && one.data.nextCursor === '7724', 'chat --turns 1: the last user message and its reply, with the cursor of what is older')
    const older = await call(h, 'chat', { console: '1', turns: 1, before: one.data.nextCursor }, caller1)
    check(older.ok && older.data.items[0].id === '7018' && older.data.items[0].role === 'user' && older.data.nextCursor === '7018', 'chat --before <cursor> pages back one turn at a time')
    const full = await call(h, 'chat', { console: '1', tools: true, thinking: true }, caller1)
    check(full.data.items.some((m) => m.blocks.some((b) => b.t === 'thinking')) && full.data.items.some((m) => m.role === 'tool' && m.blocks.some((b) => b.t === 'toolResult')), '--tools and --thinking add tool output and reasoning')
    const cx = await call(h, 'chat', { console: '3', turns: 5 }, caller1)
    check(cx.ok && cx.data.provider === 'codex' && cx.data.turns === 1 && cx.data.items[0].role === 'user' && cx.data.items.some((m) => m.blocks.some((b) => b.t === 'text' && b.text === 'Fixed the failing test.')), 'chat of a Codex console decodes its rollout')
    check(located.every((id) => id === 'p1' || id === 'p3'), 'chat locates only the asked console')
    // A text over 4 KB is clipped with truncated; pages across a scan-capped empty page.
    const dir = tmp('chat-fx')
    const big = path.join(dir, 'big.jsonl')
    fs.writeFileSync(big, [claudeRec('user', 'a', 'pregunta vieja'), claudeRec('assistant', 'b', 'x'.repeat(5000)), ''].join('\n'))
    const junk = ('not json ' + 'z'.repeat(1015) + '\n').repeat(9 * 1024)
    fs.appendFileSync(big, junk)
    fs.appendFileSync(big, [claudeRec('user', 'c', 'pregunta nueva'), claudeRec('assistant', 'd', 'respuesta'), ''].join('\n'))
    locs.p1 = { ok: true, path: big, provider: 'claude' }
    const two = await call(h, 'chat', { console: '1', turns: 2 }, caller1)
    const longText = two.data.items.find((m) => m.role === 'assistant')?.blocks[0]
    check(two.ok && two.data.turns === 2 && two.data.items[0].blocks[0].text === 'pregunta vieja' && two.data.nextCursor === null, 'chat keeps reading past a page that scanned 8 MB without a message (empty page with a cursor)')
    check(longText.text.length === 4096 && longText.truncated === true, 'a text block over 4 KB is clipped to 4096 with truncated')
    const newest = await call(h, 'chat', { console: '1', turns: 1 }, caller1)
    check(newest.data.items.length === 2 && newest.data.items[0].blocks[0].text === 'pregunta nueva' && newest.data.nextCursor !== null, 'one turn needs one page; the cursor points past the junk')
    // One line with a tool result and the user's prompt (`<off>.0`, `<off>.1`): the page starts at the whole line.
    const shared = path.join(dir, 'shared.jsonl')
    const toolAndText = JSON.stringify({ isSidechain: false, type: 'user', uuid: 'c', timestamp: '2026-10-01T10:00:00.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'salida del tool' }, { type: 'text', text: 'segunda pregunta' }] } })
    fs.writeFileSync(shared, [claudeRec('user', 'a', 'primera'), claudeRec('assistant', 'b', 'ok'), toolAndText, claudeRec('assistant', 'd', 'respuesta'), ''].join('\n'))
    locs.p1 = { ok: true, path: shared, provider: 'claude' }
    const last = await call(h, 'chat', { console: '1', tools: true, turns: 1 }, caller1)
    const prev = await call(h, 'chat', { console: '1', tools: true, turns: 1, before: last.data.nextCursor }, caller1)
    const results = [...last.data.items, ...prev.data.items].filter((m) => m.blocks.some((b) => b.t === 'toolResult'))
    check(last.ok && prev.ok && last.data.turns === 1 && /\.0$/.test(last.data.items[0].id) && last.data.items[1].role === 'user' && results.length === 1 && prev.data.items[0].blocks[0].text === 'primera' && prev.data.nextCursor === null, 'chat --tools paging: a tool result sharing a line with the prompt shows exactly once')
    // At most CTL_CHAT_MAX_PAGES (8) pages of 50 per call, even without a turn found.
    const long = path.join(dir, 'long.jsonl')
    fs.writeFileSync(long, [claudeRec('user', 'u0', 'arranque'), ...Array.from({ length: 450 }, (_, i) => claudeRec('assistant', `r${i}`, `paso ${i}`)), ''].join('\n'))
    locs.p1 = { ok: true, path: long, provider: 'claude' }
    const capped = await call(h, 'chat', { console: '1', turns: 2 }, caller1)
    check(capped.ok && capped.data.items.length === 400 && capped.data.turns === 0 && capped.data.nextCursor !== null, 'chat reads at most 8 pages of 50 messages per call, with a cursor to go on')
    // No transcript.
    locs.p1 = { ok: false, reason: 'noTranscript', pending: true }
    const pend = await call(h, 'chat', { console: '1' }, caller1)
    check(pend.ok && pend.data.pending === true && pend.data.items.length === 0 && pend.data.nextCursor === null, 'a transcript still coming is ok with items [] and pending')
    locs.p1 = { ok: false, reason: 'ambiguous' }
    const amb = await call(h, 'chat', { console: '1' }, caller1)
    check(!amb.ok && amb.error.code === 'not_found' && amb.data.reason === 'ambiguous' && /snaos read p1/.test(amb.error.message), 'a transcript reason is not_found with data.reason (never exit 4), suggesting read on a running console')
    w.running.delete('p2')
    const stopped = await call(h, 'chat', { console: '2' }, caller1)
    check(stopped.error.code === 'not_found' && stopped.data.reason === 'noTranscript' && /snaos peek p2/.test(stopped.error.message), 'without a pty it suggests peek instead')
    locs.p1 = { ok: true, path: path.join(dir, 'gone.jsonl'), provider: 'claude' }
    check((await call(h, 'chat', { console: '1' }, caller1)).data.reason === 'noTranscript', 'a located file that vanished is noTranscript')
    check((await call(h, 'chat', { console: 'srv:1' }, caller1)).error.code === 'ssh_protected', 'chat of a profile console: ssh_protected')
    check((await call(h, 'chat', { console: '1', before: 'abc' }, caller1)).error.code === 'bad_request' && (await call(h, 'chat', { console: '1', before: -1 }, caller1)).error.code === 'bad_request' && (await call(h, 'chat', { console: '1', turns: 0 }, caller1)).error.code === 'bad_request', '--before must be a non-negative integer cursor; --turns positive')
    check((await call(makeHandlers(w), 'chat', { console: '1' }, caller1)).error.code === 'disabled', 'no chat service attached: disabled')
    check(!w.ops.some((o) => o.kind === 'attention'), 'chat never touches the attention marks')
  }
  // peek
  {
    const w = fakeWorld()
    const svc = { chat: { locate: async (id) => (id === 'p3' ? { ok: true, path: path.join(FIX, 'codex-rollout.jsonl'), provider: 'codex' } : { ok: false, reason: 'noTranscript' }) } }
    const h = makeHandlers(w, undefined, { services: () => svc })
    w.states.p1 = { paneId: 'p1', provider: 'claude', state: 'action', precise: true, notify: false, attention: true, reason: 'permission', pendingCount: 1, pending: [{ id: 'tu1', kind: 'permission', toolName: 'Bash', summary: 'rm -rf build', questions: [] }], stateSince: 1000, activity: 'Bash: rm -rf build', lastMessage: 'listo para borrar', model: 'opus', effort: 'high', ultracode: true, sessionId: 'secret-session' }
    const pk = await call(h, 'peek', { console: '1' }, null)
    const d = pk.data
    check(pk.ok && d.paneId === 'p1' && d.state === 'action' && d.attention === true && d.reason === 'permission' && d.pendingCount === 1 && d.provider === 'claude', 'peek: state, attention, reason and pending count from stateOf')
    check(JSON.stringify(d.pending) === '[{"kind":"permission","toolName":"Bash","summary":"rm -rf build"}]' && !('sessionId' in d), 'peek: pending summarized (no ids or options), nothing desktop-only leaks')
    check(d.model === 'opus' && d.effort === 'high' && d.ultracode === true && d.lastMessage === 'listo para borrar' && d.statusLine === 'corriendo tests' && d.stateSince === 1000, 'peek: model, effort and Ultracode read-back, last reply and status line')
    check(JSON.stringify(d.lines) === '["uno","dos","tres"]' && w.ops.at(-1).kind === 'read' && w.ops.at(-1).lines === 30, 'peek: the last 30 screen lines by default')
    check(!w.ops.some((o) => o.kind === 'attention') && w.states.p1.attention === true, 'peek never clears attention (no ack, no attention op)')
    await call(h, 'peek', { console: '1', lines: 5000 }, null)
    check(w.ops.at(-1).lines === 2000, 'peek --lines is capped like read')
    w.running.delete('p3')
    const cx = await call(h, 'peek', { console: 'api:3' }, null)
    check(cx.ok && cx.data.running === false && cx.data.lines.length === 0 && cx.data.state === null && cx.data.provider === 'codex' && cx.data.lastMessage === 'Fixed the failing test.', 'peek without a pty: running false, lines [], last reply from the transcript when the status has none')
    check((await call(h, 'peek', { console: 'srv:1' }, null)).error.code === 'ssh_protected', 'peek of a profile console: ssh_protected')
    const shell = await call(makeHandlers(w), 'peek', { console: '2' }, caller1)
    check(shell.ok && shell.data.type === 'shell' && !('provider' in shell.data) && shell.data.state === null, 'peek of a shell without a chat service still answers')
    check((await call(h, 'peek', { console: '1', lines: 0 }, null)).error.code === 'bad_request', 'peek --lines 0 is bad_request')
    // The read bucket: 120 a minute per caller.
    const hb = makeHandlers(fakeWorld())
    let okCount = 0
    for (let i = 0; i < 120; i++) if ((await call(hb, 'peek', { console: '2' }, caller1)).ok) okCount++
    check(okCount === 120 && (await call(hb, 'peek', { console: '2' }, caller1)).error.code === 'rate_limited', 'the 121st chat or peek in a minute: rate_limited')
    check((await call(hb, 'peek', { console: '2' }, null)).ok, 'the read budget is per caller')
  }
  // kill, restart, rename
  {
    const w = fakeWorld()
    const h = makeHandlers(w)
    const k = await call(h, 'kill', { console: '2' }, caller1)
    check(k.ok && k.data.killed === true && k.data.closed === false && w.ops.at(-1).kind === 'kill' && w.ops.at(-1).paneId === 'p2' && w.ops.at(-1).close === false && w.ops.at(-1).workspaceId === 'w1' && w.ops.at(-1).running === true, 'kill 2: the renderer op kill (explicit killPanePtys there), running per main')
    w.running.delete('p3')
    const k2 = await call(h, 'kill', { console: '3', close: true }, caller1)
    check(k2.ok && k2.data.killed === false && k2.data.closed === true && w.ops.at(-1).close === true && w.ops.at(-1).running === false, 'kill of a stopped console is ok with killed false (the op says running false); --close closes it')
    check((await call(h, 'kill', { console: 'self' }, caller1)).error.code === 'bad_request' && (await call(h, 'kill', { console: '1' }, caller1)).error.code === 'bad_request', 'a console cannot kill itself')
    check((await call(h, 'kill', { console: 'srv:1' }, caller1)).error.code === 'ssh_protected' && (await call(h, 'kill', { console: 'srv:2' }, caller1)).ok, "kill honors cliProtectSsh (a local pane with setupId '' is fine)")
    const r1 = await call(h, 'restart', { console: '3', resume: true }, caller1)
    check(r1.ok && r1.data.mode === 'resume' && w.ops.at(-1).kind === 'restart' && w.ops.at(-1).resume === true, 'restart --resume')
    check((await call(h, 'restart', { console: '3', resume: false }, caller1)).data.mode === 'fresh' && w.ops.at(-1).resume === false, 'restart --fresh')
    check((await call(h, 'restart', { console: '2' }, caller1)).data.mode === 'default' && !('resume' in w.ops.at(-1)), 'restart without a flag: the header button')
    check((await call(h, 'restart', { console: '2', resume: true }, caller1)).error.code === 'bad_request', '--resume on a shell is bad_request')
    check((await call(h, 'restart', { console: 'self' }, caller1)).error.code === 'bad_request' && (await call(h, 'restart', { console: 'srv:1' }, caller1)).error.code === 'ssh_protected', 'restart: self guard and SSH guard')
    const rn = await call(h, 'rename', { console: '2', title: '  Logs\nde ' + 'x'.repeat(80) }, caller1)
    check(rn.ok && w.ops.at(-1).kind === 'renamePane' && w.ops.at(-1).title.length === 60 && w.ops.at(-1).title.startsWith('Logs de x'), 'rename flattens the title and clips it at 60')
    check((await call(h, 'rename', { console: '2', title: '  ' }, caller1)).error.code === 'bad_request', 'an empty title is bad_request')
    const hm = makeHandlers(fakeWorld())
    let n = 0
    for (let i = 0; i < 30; i++) if ((await call(hm, 'rename', { console: '2', title: `t${i}` }, caller1)).ok) n++
    check(n === 30 && (await call(hm, 'rename', { console: '2', title: 'otra' }, caller1)).error.code === 'rate_limited', 'the 31st console change in a minute: rate_limited')
  }
  // workspaces
  {
    const w = fakeWorld()
    w.list.workspaces[1].favorite = true
    const dirs = []
    const h = makeHandlers(w, undefined, { platform: 'win32', isDir: async (p) => { dirs.push(p); return p.toLowerCase().includes('repos') } })
    check((await call(h, 'ws.new', { path: 'relative\\dir' }, caller1)).error.code === 'bad_request' && dirs.length === 0, 'ws new with a relative path is bad_request (main never guesses a cwd)')
    const gone = await call(h, 'ws.new', { path: 'C:\\nope\\x' }, caller1)
    check(gone.error.code === 'not_found' && /C:\\nope\\x/.test(gone.error.message) && dirs.at(-1) === 'C:\\nope\\x', 'a missing folder is not_found (checked with a stat)')
    const made = await call(h, 'ws.new', { path: 'C:\\repos\\web\\' }, caller1)
    check(made.ok && made.data.workspaceId === 'w-new' && made.data.index === 3 && made.data.name === 'web' && w.ops.at(-1).kind === 'createWorkspace' && w.ops.at(-1).cwd === 'C:\\repos\\web' && w.ops.at(-1).focus === false, 'ws new: name from the folder, without focus by default')
    await call(h, 'ws.new', { path: 'C:\\repos\\web', name: 'Front\nend', focus: true }, caller1)
    check(w.ops.at(-1).name === 'Front end' && w.ops.at(-1).focus === true, 'ws new: a given name (one line) and --focus')
    const comp = await call(h, 'ws.new', { path: 'C:\\repos\\web', composer: true }, caller1)
    check(comp.ok && comp.data.composer === true && w.ops.at(-1).kind === 'composer' && w.ops.at(-1).name === 'web', 'ws new --composer opens the card with the folder and name')
    let wn = 0
    for (let i = 0; i < 5; i++) if ((await call(h, 'ws.new', { path: 'C:\\repos\\web' }, null)).ok) wn++
    check(wn === 5 && (await call(h, 'ws.new', { path: 'C:\\repos\\web' }, null)).error.code === 'rate_limited', 'the 6th ws new in a minute: rate_limited')
    // --composer shares the bucket (it also brings the window forward).
    const hc = makeHandlers(fakeWorld(), undefined, { platform: 'win32', isDir: async () => true })
    let cn = 0
    for (let i = 0; i < 5; i++) if ((await call(hc, 'ws.new', { path: 'C:\\repos\\web', composer: true }, caller1)).ok) cn++
    check(cn === 5 && (await call(hc, 'ws.new', { path: 'C:\\repos\\web', composer: true }, caller1)).error.code === 'rate_limited' && (await call(hc, 'ws.new', { path: 'C:\\repos\\web' }, caller1)).error.code === 'rate_limited', 'ws new --composer counts against the ws new budget: the 6th is rate_limited, plain ones too')
    check((await call(h, 'ws.close', { workspace: 'srv' }, caller1)).error.code === 'bad_request', 'ws close without --yes is bad_request in main too')
    check((await call(h, 'ws.close', { workspace: 'api', yes: true }, caller1)).error.code === 'bad_request', 'a console cannot close its own workspace')
    check((await call(h, 'ws.close', { workspace: 'srv', yes: true }, caller1)).error.code === 'ssh_protected', 'a workspace with a live profile console: ssh_protected')
    w.running.delete('p4')
    // A console visiting from api goes back home: not counted, and its (inherited) profile does not block.
    w.list.workspaces[1].panes.push({ id: 'pv', title: 'Visita', type: 'shell', homeWorkspaceId: 'w1' })
    w.running.add('pv')
    const closed = await call(h, 'ws.close', { workspace: 'srv', yes: true }, caller1)
    check(closed.ok && closed.data.consolesEnded === 1 && closed.data.name === 'srv' && w.ops.at(-1).kind === 'deleteWorkspace' && w.ops.at(-1).workspaceId === 'w2', 'ws close --yes: deleteWorkspace, counting the running consoles of its own (a visiting one goes home)')
    check((await call(h, 'ws.close', { workspace: 'nope', yes: true }, null)).error.code === 'not_found', 'ws close of an unknown workspace: not_found')
    await call(h, 'ws.fav', { workspace: 'api', favorite: false }, caller1)
    check(w.ops.at(-1).kind === 'setFavorite' && w.ops.at(-1).favorite === false && w.ops.at(-1).workspaceId === 'w1', 'ws fav --off')
    await call(h, 'ws.rename', { workspace: '2', name: '  Servidor\n' }, caller1)
    check(w.ops.at(-1).kind === 'renameWorkspace' && w.ops.at(-1).name === 'Servidor' && (await call(h, 'ws.rename', { workspace: '2', name: ' ' }, caller1)).error.code === 'bad_request', 'ws rename: one line, empty is bad_request')
    const ls = await call(h, 'ls', {}, caller1)
    check(ls.data.workspaces[1].favorite === true && !('favorite' in ls.data.workspaces[0]), 'ls carries favorite')
  }
  // notes
  {
    const w = fakeWorld()
    const notes = fakeNotes()
    notes.seed('w1', 'n-plan', '# Plan\n\nhola')
    notes.seed('w2', 'n-other', 'otra')
    const h = makeHandlers(w, undefined, { services: () => ({ notes }) })
    const ls = await call(h, 'notes.ls', {}, caller1)
    check(ls.ok && ls.data.workspaceId === 'w1' && ls.data.notes.length === 1 && ls.data.notes[0].title === 'Plan', "notes ls uses the caller's workspace")
    check((await call(h, 'notes.ls', { workspace: 'srv' }, caller1)).data.notes[0].id === 'n-other', 'notes ls --workspace')
    const got = await call(h, 'notes.get', { note: 'plan' }, caller1)
    check(got.ok && got.data.note.text === '# Plan\n\nhola' && /n-plan\.md$/.test(got.data.note.path) && typeof got.data.note.rev === 'string', 'notes get by title gives text, rev and path')
    const made = await call(h, 'notes.new', { title: 'Ideas\nnuevas', text: 'uno', open: true }, caller1)
    check(made.ok && notes.text('w1', made.data.note.id) === '# Ideas nuevas\n\nuno' && made.data.opened === true && w.ops.at(-1).kind === 'openNote' && w.ops.at(-1).noteId === made.data.note.id, 'notes new --title writes "# T\\n\\nbody"; --open shows it')
    const stale = await call(h, 'notes.set', { note: 'n-plan', text: 'pisado', rev: 'r-old' }, caller1)
    check(!stale.ok && stale.error.code === 'conflict' && stale.data.current.rev && !('text' in stale.data.current) && notes.text('w1', 'n-plan') === '# Plan\n\nhola', 'notes set with a stale --rev: conflict with data.current.rev and never the text')
    const fresh = await call(h, 'notes.set', { note: 'n-plan', text: '# Plan\n\nhola', rev: got.data.note.rev }, caller1)
    check(fresh.ok && fresh.data.note.rev !== got.data.note.rev, 'notes set with the current --rev writes')
    await call(h, 'notes.append', { note: 'Plan', text: 'mas' }, caller1)
    check(notes.text('w1', 'n-plan') === '# Plan\n\nhola\nmas', 'append adds a line break before the text when the note lacks one')
    await Promise.all([call(h, 'notes.append', { note: 'n-plan', text: 'A\n' }, caller1), call(h, 'notes.append', { note: 'n-plan', text: 'B\n' }, caller1)])
    const both = notes.text('w1', 'n-plan')
    check(both.includes('A\n') && both.includes('B\n') && both.startsWith('# Plan\n\nhola\nmas\n'), 'two concurrent appends both land (serialized per note)')
    notes.interfere = () => notes.seed('w1', 'n-plan', notes.text('w1', 'n-plan') + 'desde el desktop\n')
    const retried = await call(h, 'notes.append', { note: 'n-plan', text: 'final' }, caller1)
    check(retried.ok && notes.text('w1', 'n-plan').endsWith('desde el desktop\nfinal'), 'an edit between the read and the write is a conflict, retried once from a fresh read')
    check((await call(h, 'notes.append', { note: 'n-plan', text: 'x'.repeat(1024 * 1024) }, caller1)).error.code === 'bad_request', 'append past 1 MB is bad_request')
    check((await call(h, 'notes.set', { note: 'n-plan' }, caller1)).error.code === 'bad_request' && (await call(h, 'notes.get', { note: 'nope' }, caller1)).error.code === 'not_found', 'set without a text; an unknown note')
    const op = await call(h, 'notes.open', { note: 'n-plan' }, caller1)
    check(op.ok && w.ops.at(-1).kind === 'openNote' && w.ops.at(-1).workspaceId === 'w1' && w.ops.at(-1).noteId === 'n-plan', 'notes open sends openNote')
    const rm = await call(h, 'notes.rm', { note: 'n-plan' }, caller1)
    check(rm.ok && rm.data.trashed === true && notes.calls.includes('delete') && notes.text('w1', 'n-plan') === undefined, 'notes rm goes through delete (the trash)')
    check((await call(makeHandlers(w), 'notes.ls', {}, caller1)).error.code === 'disabled', 'no notes service: disabled')
    w.list.activeWorkspaceId = null
    check((await call(h, 'notes.ls', {}, null)).error.code === 'bad_request', 'no workspace at all: bad_request')
    const hn = makeHandlers(fakeWorld(), undefined, { services: () => ({ notes: fakeNotes() }) })
    let made60 = 0
    for (let i = 0; i < 60; i++) if ((await call(hn, 'notes.new', { text: `n${i}` }, caller1)).ok) made60++
    check(made60 === 60 && (await call(hn, 'notes.new', { text: 'una mas' }, caller1)).error.code === 'rate_limited', 'the 61st note write in a minute: rate_limited')
  }
}

// --- H/I (app 2.3.0, 4b). usage and Claude accounts -----------------------------------

const FAKE_TOKEN = 'sk-ant-oat01-' + 'Q'.repeat(40)

/** A usage poller handle: Claude, Codex and a custom row with token counts. */
function fakeUsage(over = {}) {
  const u = {
    on: true,
    loads: 0,
    snap: {
      updatedAt: 1760000000000,
      services: 'operational',
      error: `boom ${FAKE_TOKEN}`,
      activeAccount: { id: 'acc_aaaaaaaaaaaa', rank: 0, role: 'primary', label: 'Trabajo', other: { id: 'acc_bbbbbbbbbbbb', rank: 1, role: 'secondary', label: 'yo@mail.com' }, others: [{ id: 'acc_bbbbbbbbbbbb', rank: 1, role: 'secondary', label: 'yo@mail.com', ready: true }] },
      rows: [
        { id: 'claude.5h', provider: 'claude', kind: '5h', label: 'Session', percent: 42.4, resetsAt: '2026-10-20T15:00:00.000Z', status: 'ok', planType: 'max', extra: FAKE_TOKEN },
        { id: 'claude.7d', provider: 'claude', kind: '7d', label: 'Weekly', percent: 80, resetsAt: null, status: 'ok', stale: true },
        { id: 'codex.5h', provider: 'codex', kind: '5h', label: 'Session', percent: null, status: 'error' },
        { id: 'custom.r1', provider: 'custom', kind: 'custom', label: 'gpt-x', percent: 10, used: 1234, limit: 99999, status: 'ok' },
      ],
    },
    enabled: () => u.on,
    load: async () => { u.loads++; return JSON.parse(JSON.stringify(u.snap)) },
    ...over,
  }
  return u
}

/** An AccountService fake: ClaudeAccountsState with emails and a stray token the adapter must drop. */
function fakeAccountSource() {
  const win = (percent, source = 'live') => ({ percent, resetsAt: '2026-10-21T10:00:00.000Z', at: 1, source })
  const view = (id, role, label, active, extra = {}) => ({ id, rank: role === 'primary' ? 0 : 1, role, label, email: `${role}@mail.com`, organizationName: 'Org', subscriptionType: 'max', capturedAt: 1, active, tokenState: 'ok', needsRecapture: false, identityConfirmed: true, usage: { fiveHour: win(active ? 30 : 5, active ? 'live' : 'parked'), sevenDay: win(50, active ? 'live' : 'parked') }, accessToken: FAKE_TOKEN, ...extra })
  const src = {
    calls: [],
    next: { ok: true },
    state: {
      supported: true,
      liveSwitch: true,
      accounts: [view('acc_aaaaaaaaaaaa', 'primary', 'Trabajo', true), view('acc_bbbbbbbbbbbb', 'secondary', 'Personal', false)],
      activeId: 'acc_aaaaaaaaaaaa',
      liveIdentity: 'known',
      liveEmail: 'otro@mail.com',
      autoPaused: null,
      lastSwitch: { at: Date.UTC(2026, 9, 20, 9, 30), from: 'acc_bbbbbbbbbbbb', to: 'acc_aaaaaaaaaaaa', reason: 'manual' },
      pending: null,
      blocked: null,
      restartNeeded: [],
      credentialsRaw: `{"claudeAiOauth":{"accessToken":"${FAKE_TOKEN}"}}`,
    },
    status: () => JSON.parse(JSON.stringify(src.state)),
    settings: () => ({ autoSwitch: true, switchAtPercent: 95, returnToPrimary: true, returnBelowPercent: 90, returnMarginMinutes: 5, minDwellMinutes: 10, deferWhileWorking: true, deferMaxMinutes: 3, pollParked: true, alertOnSwitch: true }),
    async switchTo(id, reason) {
      src.calls.push({ id, reason })
      const r = typeof src.next === 'function' ? src.next(id) : src.next
      // Like switchInner (isLive ignores liveUnverified): ok without writing (no new lastSwitch) when the target is already live, or on a `noop` answer.
      const live = src.state.activeId === id && src.state.liveIdentity === 'known'
      if (r.ok && !r.noop && !live) {
        src.state.lastSwitch = { at: src.state.lastSwitch.at + 1000, from: src.state.activeId, to: id, reason }
        src.state.activeId = id
        src.state.liveIdentity = 'known'
        for (const a of src.state.accounts) a.active = a.id === id
      }
      const { noop, ...out } = r
      return { ...out, state: { ...src.status(), secret: FAKE_TOKEN } }
    },
  }
  return src
}

async function usageAccountChecks() {
  const { ctlAccountsView, ctlAccount } = load('src/main/cli/accountsView.ts')
  const clean = (v, label) => {
    const json = JSON.stringify(v)
    check(!json.includes('sk-ant') && !json.includes('@') && !json.includes('accessToken') && !json.includes('credentials') && !json.includes('"used"') && !json.includes('"limit"'), `${label}: no token, credentials, email or token counts`)
  }
  // usage
  {
    const usage = fakeUsage()
    const h = makeHandlers(fakeWorld(), undefined, { services: () => ({ usage }) })
    const all = await call(h, 'usage', {}, caller1)
    check(all.ok && all.data.rows.length === 3 && all.data.rows.map((r) => r.id).join() === 'claude.5h,claude.7d,codex.5h' && usage.loads === 1, 'usage: Claude and Codex rows only (the custom row is dropped), read through load()')
    const r0 = all.data.rows[0]
    check(JSON.stringify(Object.keys(r0).sort()) === JSON.stringify(['id', 'kind', 'label', 'percent', 'planType', 'provider', 'resetsAt', 'status']) && r0.percent === 42.4 && r0.planType === 'max', 'usage: each row carries only the picked fields')
    check(all.data.rows[1].stale === true && all.data.rows[2].percent === null && all.data.rows[2].resetsAt === null && all.data.services === 'operational' && all.data.updatedAt === 1760000000000 && !('error' in all.data), 'usage: stale, null percent and reset, services; the snapshot error never goes out')
    check(all.data.account.id === 'acc_aaaaaaaaaaaa' && all.data.account.rank === 1 && all.data.account.slot === 'primary' && all.data.account.label === 'Trabajo' && !('other' in all.data.account) && !('others' in all.data.account), 'usage: the active Claude account by id, #rank (1-based), slot and label')
    clean(all.data, 'usage')
    const cx = await call(h, 'usage', { provider: 'codex' }, caller1)
    check(cx.ok && cx.data.rows.length === 1 && cx.data.rows[0].provider === 'codex' && !('account' in cx.data), 'usage --provider codex: Codex rows, no Claude account')
    check((await call(h, 'usage', { provider: 'claude' }, caller1)).data.rows.every((r) => r.provider === 'claude'), 'usage --provider claude')
    check((await call(h, 'usage', { provider: 'custom' }, caller1)).error.code === 'bad_request', 'usage --provider custom: bad_request')
    usage.snap.activeAccount.label = 'yo@mail.com'
    check((await call(h, 'usage', {}, caller1)).data.account.label === '', 'usage: a label holding an @ goes out as ""')
    usage.on = false
    const off = await call(h, 'usage', {}, caller1)
    check(!off.ok && off.error.code === 'disabled' && /Settings > AI Usage/.test(off.error.message), 'usage with the bars off: disabled, pointing at Settings')
    check((await call(makeHandlers(fakeWorld()), 'usage', {}, caller1)).error.code === 'disabled', 'no usage service attached: disabled')
    const broken = makeHandlers(fakeWorld(), undefined, { services: () => ({ usage: fakeUsage({ load: async () => { throw new Error(FAKE_TOKEN) } }) }) })
    const failed = await call(broken, 'usage', {}, caller1)
    check(failed.error.code === 'internal' && !JSON.stringify(failed).includes('sk-ant'), 'usage: a failing load is internal and never echoes the error text')
  }
  // The adapter over AccountService
  {
    const src = fakeAccountSource()
    const view = ctlAccountsView(src)
    const st = await view.status()
    check(st.supported && st.live === 'known' && st.active.id === 'acc_aaaaaaaaaaaa' && st.accounts.length === 2 && st.auto.enabled === true && st.auto.switchAtPercent === 95 && st.auto.paused === null && st.lastSwitch.reason === 'manual', 'adapter: status with the live login, accounts, last switch and the automatic switch')
    check(JSON.stringify(Object.keys(st.accounts[0]).sort()) === JSON.stringify(['active', 'fiveHour', 'id', 'label', 'plan', 'provider', 'rank', 'ready', 'sevenDay', 'slot']) && st.accounts[1].fiveHour.source === 'parked' && st.accounts[0].plan === 'max', 'adapter: each account carries only the picked fields')
    check(st.accounts[0].rank === 1 && st.accounts[1].rank === 2 && ctlAccount({ ...src.state.accounts[0], rank: 4, role: 'secondary' }).rank === 5 && ctlAccount({ ...src.state.accounts[1], rank: undefined }).rank === 2, 'adapter: rank is 1-based (a view without one falls back to its role)')
    clean(st, 'adapter status')
    check(ctlAccount({ ...src.state.accounts[0], label: 'yo@mail.com', needsRecapture: true }).label === '' && ctlAccount({ ...src.state.accounts[0], needsRecapture: true }).ready === false, 'adapter: a label with an @ is ""; needsRecapture is ready: false')
    const sw = await view.switchTo('acc_bbbbbbbbbbbb', 'cli')
    check(sw.ok === true && JSON.stringify(sw) === '{"ok":true}' && src.calls.at(-1).reason === 'cli', 'adapter: a switch answers only { ok }, never the account state')
    src.next = { ok: false, error: 'locked' }
    check(JSON.stringify(await view.switchTo('acc_aaaaaaaaaaaa', 'cli')) === '{"ok":false,"error":"locked"}', 'adapter: a failed switch answers only { ok, error }')
    check(!('unverified' in st), 'adapter: no unverified field while the live login is identified')
    src.state.liveUnverified = true
    check((await view.status()).unverified === true, 'adapter: liveUnverified goes out as unverified: true')
  }
  // account.ls / status / use through the handlers
  {
    const src = fakeAccountSource()
    const accounts = ctlAccountsView(src)
    const w = fakeWorld()
    const h = makeHandlers(w, undefined, { services: () => ({ accounts }) })
    const ls = await call(h, 'account.ls', {}, caller1)
    check(ls.ok && ls.data.accounts.length === 2 && ls.data.accounts[0].slot === 'primary' && ls.data.accounts[0].active, 'account ls lists the saved Claude accounts')
    clean(ls.data, 'account ls')
    check((await call(h, 'account.ls', { provider: 'claude' }, caller1)).ok && (await call(h, 'account.ls', { provider: 'codex' }, caller1)).error.code === 'bad_request', 'account ls --provider claude; codex has no saved accounts (bad_request)')
    const st = await call(h, 'account.status', {}, caller1)
    check(st.ok && st.data.active.label === 'Trabajo' && st.data.auto.enabled === true, 'account status')
    clean(st.data, 'account status')
    const same = await call(h, 'account.use', { account: 'primary' }, caller1)
    check(same.ok && same.data.changed === false && same.data.active.id === 'acc_aaaaaaaaaaaa' && src.calls.length === 0, 'account use of the live account: changed false, AccountService never called')
    const toSec = await call(h, 'account.use', { account: 'Secondary' }, caller1)
    check(toSec.ok && toSec.data.changed === true && toSec.data.active.slot === 'secondary' && toSec.data.active.active === true && src.calls.at(-1).id === 'acc_bbbbbbbbbbbb' && src.calls.at(-1).reason === 'cli', "account use secondary (any case): switchTo(id, 'cli'), changed true")
    clean(toSec.data, 'account use')
    const byId = await call(h, 'account.use', { account: 'acc_aaaaaaaaaaaa' }, { paneId: 'p3', ptyId: 'pty-p3', workspaceId: 'w1' })
    check(byId.ok && byId.data.changed === true && src.calls.at(-1).id === 'acc_aaaaaaaaaaaa', 'account use by id')
    const byLabel = await call(h, 'account.use', { account: 'personal' }, null)
    check(byLabel.ok && src.calls.at(-1).id === 'acc_bbbbbbbbbbbb', 'account use by label (case-insensitive), from the master token')
    const limited = await call(h, 'account.use', { account: 'primary' }, { paneId: 'p2', ptyId: 'pty-p2', workspaceId: 'w1' })
    check(!limited.ok && limited.error.code === 'rate_limited' && src.calls.length === 3, 'the 4th switch in a minute is rate_limited, whatever console asks (one global budget)')
    check((await call(h, 'account.use', { account: 'secondary' }, caller1)).data.changed === false, 'a no-op use still answers while the budget is spent')
    check((await call(h, 'account.use', { account: 'nadie' }, caller1)).error.code === 'not_found' && (await call(h, 'account.use', { account: '  ' }, caller1)).error.code === 'bad_request' && (await call(h, 'account.use', { account: 'primary', provider: 'codex' }, caller1)).error.code === 'bad_request', 'account use: unknown, empty and --provider codex')
  }
  {
    const src = fakeAccountSource()
    src.state.accounts[1].label = 'Trabajo'
    const h = makeHandlers(fakeWorld(), undefined, { services: () => ({ accounts: ctlAccountsView(src) }) })
    const amb = await call(h, 'account.use', { account: 'trabajo' }, caller1)
    check(!amb.ok && amb.error.code === 'ambiguous' && amb.error.message.includes('acc_bbbbbbbbbbbb') && src.calls.length === 0, 'two accounts with the same label: ambiguous, with the ids')
    src.state.accounts[1].needsRecapture = true
    const locked = await call(h, 'account.use', { account: 'secondary' }, caller1)
    check(!locked.ok && locked.error.code === 'disabled' && /capture it again/.test(locked.error.message) && src.calls.length === 0, 'a login to capture again: disabled before any switch')
    src.state.accounts[1].needsRecapture = false
    src.state.liveIdentity = 'unknown'
    await call(h, 'account.use', { account: 'primary' }, caller1)
    check(src.calls.length === 1 && src.calls[0].id === 'acc_aaaaaaaaaaaa', 'the saved active account while an unknown login is live: not a no-op, the switch runs (main decides)')
    src.state.supported = false
    check((await call(h, 'account.use', { account: 'secondary' }, caller1)).error.code === 'disabled', 'no saved logins on this machine: disabled')
  }
  {
    // app 2.4.0: N accounts, `account use <n>` by the 1-based rank.
    const src = fakeAccountSource()
    const third = { ...src.state.accounts[1], id: 'acc_cccccccccccc', rank: 2, label: '2', active: false }
    src.state.accounts.push(third)
    const h = makeHandlers(fakeWorld(), undefined, { services: () => ({ accounts: ctlAccountsView(src) }) })
    const ls = await call(h, 'account.ls', {}, caller1)
    check(ls.data.accounts.map((a) => `${a.rank}:${a.slot}`).join() === '1:primary,2:secondary,3:secondary', 'account ls: #1..#3, slot derived from the rank')
    const three = await call(h, 'account.use', { account: '3' }, caller1)
    check(three.ok && three.data.changed === true && src.calls.at(-1).id === 'acc_cccccccccccc' && three.data.active.rank === 3, 'account use 3 switches to #3')
    const two = await call(h, 'account.use', { account: '#2' }, caller1)
    check(two.ok && src.calls.at(-1).id === 'acc_bbbbbbbbbbbb', 'account use #2: the rank wins over a label "2" of another account')
    check((await call(h, 'account.use', { account: 'secondary' }, caller1)).data.changed === false && src.calls.length === 2, 'secondary still names #2 (the live one now: no-op)')
    check((await call(h, 'account.use', { account: '9' }, caller1)).error.code === 'not_found', 'a rank nobody has: not_found')
  }
  {
    // The live login changed and is not identified yet (liveUnverified).
    const src = fakeAccountSource()
    src.state.liveUnverified = true
    const h = makeHandlers(fakeWorld(), undefined, { services: () => ({ accounts: ctlAccountsView(src) }) })
    const st = await call(h, 'account.status', {}, caller1)
    check(st.ok && st.data.unverified === true && st.data.live === 'known', 'account status carries unverified: true')
    const unv = await call(h, 'account.use', { account: 'primary' }, caller1)
    check(!unv.ok && unv.error.code === 'busy' && /not identified yet/.test(unv.error.message) && src.calls.length === 1, 'account use of the shown active account while unverified: not a no-op; still unverified after the switch: busy')
    src.state.liveUnverified = false
    src.next = { ok: true, noop: true }
    const stale = await call(h, 'account.use', { account: 'secondary' }, caller1)
    check(stale.ok && stale.data.changed === false && src.calls.length === 2, 'switchTo ok without a new last switch (the target was already live): changed false')
    src.next = { ok: true }
    const real = await call(h, 'account.use', { account: 'secondary' }, caller1)
    check(real.ok && real.data.changed === true && src.state.lastSwitch.reason === 'cli', 'a switch that moved the last switch: changed true')
  }
  {
    // Error mapping (each from a fresh handler, so the budget never interferes).
    const mapped = {}
    for (const e of ['not_found', 'locked', 'busy', 'identity_failed', 'unknown_live_account', 'unsupported', 'encryption_unavailable', 'io']) {
      const src = fakeAccountSource()
      src.next = { ok: false, error: e }
      const h = makeHandlers(fakeWorld(), undefined, { services: () => ({ accounts: ctlAccountsView(src) }) })
      mapped[e] = (await call(h, 'account.use', { account: 'secondary' }, caller1)).error.code
    }
    check(JSON.stringify(mapped) === JSON.stringify({ not_found: 'not_found', locked: 'disabled', busy: 'busy', identity_failed: 'busy', unknown_live_account: 'disabled', unsupported: 'disabled', encryption_unavailable: 'disabled', io: 'internal' }), 'AccountService errors map to not_found / disabled / busy / internal', mapped)
    const src = fakeAccountSource()
    src.switchTo = async () => { throw new Error(FAKE_TOKEN) }
    const h = makeHandlers(fakeWorld(), undefined, { services: () => ({ accounts: ctlAccountsView(src) }) })
    const thrown = await call(h, 'account.use', { account: 'secondary' }, caller1)
    check(thrown.error.code === 'internal' && !JSON.stringify(thrown).includes('sk-ant'), 'a throwing switch is internal and never echoes the error text')
    check((await call(makeHandlers(fakeWorld()), 'account.status', {}, caller1)).error.code === 'disabled', 'no accounts service attached: disabled')
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
  const codes = { bad_request: 2, not_found: 3, not_running: 3, exited: 3, ambiguous: 4, desktop_unavailable: 5, unauthorized: 6, ssh_protected: 7, multiline_unsafe: 7, rate_limited: 7, disabled: 7, forbidden: 7, timeout: 124, internal: 1, conflict: 8, awaiting_user: 9 }
  for (const [code, exit] of Object.entries(codes)) check((await exitOf(code)) === exit, `error ${code} exits ${exit}`)
  check((await C.run(['ping'], deps({ connect: () => { throw new C.AppUnavailable('SnAgentsOS is not running') } }))) === 5 && /not running/.test(err.at(-1)), 'no app: exit 5 with "SnAgentsOS is not running"')
  out.length = 0
  check((await C.run(['help', '--agent'], deps())) === 0 && /120 s/.test(out.join('\n')) && out.join('\n').includes('snaos 2.0.0'), 'help --agent prints the versioned guide with the 120 s Bash note')
  // v2.2.1: agent to agent messages need --enter, and the guide says how to ask for a reply.
  const guide = out.join('\n')
  check(/without `--enter` the text waits there, unsent/i.test(guide), 'guide: text without --enter stays unsent')
  check(guide.includes('## Talking to another agent') && guide.includes('snaos send <console> - --enter') && guide.includes('snaos send <console> --file <path> --enter'), 'guide: follow-ups and replies go through send with --enter')
  check(guide.includes('$SNAOS_CONSOLE_ID') && guide.includes('snaos send <your id> - --enter'), 'guide: ask for a reply with your own console id and --enter')
  check(guide.includes('exits 9 (`awaiting_user`)') && guide.includes('9 awaiting the user'), "guide: send never answers another agent's menu (exit 9 awaiting_user)")
  check(guide.includes('prompt: gate') && guide.includes('empty `snaos send <console> --enter`') && /never type the text again/i.test(guide), 'guide: a gated prompt left unsent is submitted with an empty send --enter')
  const emptyEnter = await b(['send', '3', '--enter'])
  check(emptyEnter.method === 'send' && emptyEnter.params.text === '' && emptyEnter.params.enter === true, 'an empty send --enter (the guide\'s gate recovery) parses')

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
  check(C.formatHuman('send', { paneId: 'p', enter: true }) === 'sent with Enter' && C.formatHuman('send', { paneId: 'p', enter: false }) === 'typed, not submitted (add --enter to submit)', 'human output of send says when the text was not submitted')

  // --- app 2.3.0: chat, peek, notes, consoles and workspaces -----------------------
  check(p(['notes']).command === 'notes' && p(['notes']).sub === 'ls' && p(['notes', 'get', 'Plan']).sub === 'get' && p(['notes', 'get', 'Plan']).positionals[0] === 'Plan', 'notes alone is notes ls; the subcommand is parsed off the positionals')
  check(p(['workspace', 'fav', 'api', '--off']).command === 'ws' && p(['workspace', 'fav', 'api', '--off']).flags.off === true, 'workspace is an alias of ws')
  check(/ws needs one of: new, rename, close, fav/.test(usage(['ws'])) && /unknown notes command "edit"/.test(usage(['notes', 'edit'])), 'ws alone and an unknown subcommand are usage errors')
  check(/--rev does not apply to notes new/.test(usage(['notes', 'new', 'x', '--rev', 'r1'])) && /--tools does not apply to peek/.test(usage(['peek', '2', '--tools'])), 'flags are checked per subcommand and command')
  check(p(['ws', 'close', 'api', '-y']).flags.yes === true, '-y is --yes')
  const ch = await b(['chat', 'api:2', '--turns', '2', '--before', '7724', '--tools', '--thinking', '-w', 'api'])
  check(ch.method === 'chat' && ch.params.console === 'api:2' && ch.params.turns === 2 && ch.params.before === '7724' && ch.params.tools === true && ch.params.thinking === true && ch.params.workspace === 'api', 'chat params')
  const bad = async (argv, i) => { try { await b(argv, i); return null } catch (e) { return e.message } }
  check(/--turns must be a positive integer/.test(await bad(['chat', '2', '--turns', '0'])) && /--before must be a cursor/.test(await bad(['chat', '2', '--before', 'x1'])), 'chat validates --turns and --before in the client')
  check((await b(['peek', '3', '-n', '10'])).params.lines === 10 && (await b(['peek', '3'])).method === 'peek', 'peek params')
  const focus = await b(['focus', '2', '-w', 'api'])
  check(focus.method === 'open' && focus.params.console === '2' && focus.params.workspace === 'api', 'focus 2 builds open { console }')
  check((await b(['kill', '3', '--close'])).params.close === true && (await b(['restart', '3', '--resume'])).params.resume === true && (await b(['restart', '3', '--fresh'])).params.resume === false && !('resume' in (await b(['restart', '3'])).params), 'kill and restart params')
  check(/either --resume or --fresh/.test(await bad(['restart', '3', '--resume', '--fresh'])), 'restart --resume --fresh is a usage error')
  check((await b(['rename', '2', 'Logs', 'del', 'build'])).params.title === 'Logs del build' && /rename needs/.test(await bad(['rename', '2'])), 'rename joins the title words')
  const wsNew = await b(['ws', 'new', 'Mi', 'repo'])
  check(wsNew.method === 'ws.new' && wsNew.params.name === 'Mi repo' && wsNew.params.path === path.resolve(tmpRoot), 'ws new defaults --path to the client cwd, made absolute')
  check((await b(['ws', 'new', '--path', 'sub', '--composer'])).params.path === path.resolve(tmpRoot, 'sub') && (await b(['ws', 'fav', 'api', '--off'])).params.favorite === false && (await b(['ws', 'rename', 'api', 'API', 'v2'])).params.name === 'API v2', 'ws new --path, fav --off, rename')
  const nset = await b(['notes', 'set', 'n-1', '-'], io({}, '\uFEFFnuevo texto\n'))
  check(nset.method === 'notes.set' && nset.params.note === 'n-1' && nset.params.text === 'nuevo texto\n', 'notes set <note> - reads stdin with the BOM stripped (the line break stays: notes are files)')
  check((await b(['notes', 'append', 'Plan', '--file', 'x.md'], io({ 'x.md': 'de un archivo' }))).params.text === 'de un archivo', 'notes append --file is read by the client')
  const nnew = await b(['notes', 'new', 'hola', 'mundo', '--title', 'Plan', '--open', '-w', 'api'])
  check(nnew.method === 'notes.new' && nnew.params.text === 'hola mundo' && nnew.params.title === 'Plan' && nnew.params.open === true && nnew.params.workspace === 'api', 'notes new params')
  check((await b(['notes', 'set', 'n-1', 'x', '--rev', '12-3'])).params.rev === '12-3' && /notes append needs a text/.test(await bad(['notes', 'append', 'n-1'])), 'notes set --rev; append without a body is a usage error')
  check(/use either a text or --file/.test(await bad(['notes', 'set', 'n-1', 'x', '--file', 'x.md'], io({ 'x.md': 'y' }))), 'a text and --file together are a usage error')
  {
    const out2 = [], err2 = []
    let sent2 = 0
    const d2 = { io: io({}, 'x'.repeat(1024 * 1024 + 1)), env: {}, out: (s) => out2.push(s), err: (s) => err2.push(s), connect: () => ({ endpoint: 'x', token: 't', console: true }), send: async () => { sent2++; return { ok: true, data: {} } } }
    check((await C.run(['notes', 'set', 'n-1', '-'], d2)) === 2 && sent2 === 0 && /larger than 1 MB/.test(err2.at(-1)), 'a note over 1 MB: exit 2 in the client, nothing sent')
    const quotes = { ...d2, io: io({}, '"'.repeat(600 * 1024)) }
    check((await C.run(['notes', 'append', 'n-1', '-'], quotes)) === 2 && sent2 === 0 && /after JSON escaping/.test(err2.at(-1)), 'a body over 1 MB once JSON-escaped: exit 2 in the client')
    check((await C.run(['ws', 'close', 'api'], d2)) === 2 && sent2 === 0 && /add --yes/.test(err2.at(-1)), 'ws close without --yes: exit 2, nothing sent')
    check((await C.run(['notes', 'set', 'n-1', 'x'], { ...d2, send: async () => ({ ok: false, error: { code: 'conflict', message: 'the note changed' } }) })) === 8, 'conflict exits 8')
  }
  // Human output
  const cat = C.formatHuman('chat', { paneId: 'p1', turns: 1, nextCursor: '7724', items: [
    { id: '1', role: 'user', ts: null, blocks: [{ t: 'text', text: 'arregla el login' }] },
    { id: '2', role: 'assistant', ts: null, blocks: [{ t: 'thinking', text: 'veo' }, { t: 'text', text: 'Listo', truncated: true }, { t: 'toolUse', id: 'u', name: 'Bash', summary: 'npm test' }] },
    { id: '3', role: 'tool', ts: null, blocks: [{ t: 'toolResult', toolUseId: 'u', isError: true, text: '1 failing' }] },
  ] })
  check(cat === '--- user\narregla el login\n--- assistant\n(thinking) veo\nListo [truncated]\n-> Bash: npm test\n<- error: 1 failing\nolder: snaos chat p1 --before 7724', 'chat human output: headers, tool calls, results and the older line', cat)
  check(C.formatHuman('chat', { paneId: 'p1', items: [], pending: true, nextCursor: null }) === 'no messages yet', 'chat of a transcript still coming: no messages yet')
  const pk = C.formatHuman('peek', { paneId: 'p1', title: 'Claude', type: 'claude', provider: 'claude', running: true, state: 'action', precise: true, attention: true, reason: 'permission', pending: [{ kind: 'permission', toolName: 'Bash', summary: 'rm -rf build' }], model: 'opus', effort: 'high', ultracode: false, lastMessage: 'listo', lines: ['$ npm test'] })
  check(pk.startsWith('Claude (p1)  claude  action (permission)  running\nattention: needs the user\npending: permission Bash: rm -rf build\nmodel opus, effort high, ultracode off\nlast: listo\n--- screen (last 1 lines)\n$ npm test'), 'peek human output', pk)
  check(C.formatHuman('kill', { paneId: 'p2', killed: true, closed: false }) === 'stopped console p2' && C.formatHuman('kill', { paneId: 'p2', killed: false, closed: true }) === 'console p2 was not running, closed (reopen it from the desktop)', 'kill human output')
  check(C.formatHuman('ws.close', { name: 'srv', consolesEnded: 2 }) === 'closed workspace "srv" (2 consoles ended; its notes move to the trash)' && C.formatHuman('ws.new', { workspaceId: 'w9', index: 3, name: 'web' }) === 'created workspace 3 "web" (w9)', 'ws human output')
  const nls = C.formatHuman('notes.ls', { notes: [{ id: 'n-1', title: 'Plan', updatedAt: Date.UTC(2026, 9, 1, 12), size: 12, rev: 'r' }, { id: 'n-2', title: '', updatedAt: Date.UTC(2026, 9, 1, 12), size: 0, rev: 'r' }] })
  check(/^n-1 +2026-10-01 \d\d:\d\d +12 B +Plan\nn-2 .*\(untitled\)$/.test(nls) && C.formatHuman('notes.ls', { notes: [] }) === 'no notes', 'notes ls human output', nls)
  check(C.formatHuman('notes.get', { note: { text: '# Plan\n\nhola' } }) === '# Plan\n\nhola' && C.formatHuman('ls', { workspaces: [{ index: 1, name: 'api', cwd: 'C:/api', active: false, favorite: true, consoles: [] }] }).includes('api [fav]'), 'notes get prints the raw text; ls marks favorites')
  out.length = 0
  await C.run(['help', '--agent'], deps())
  const guide2 = out.join('\n')
  check(guide2.includes('## Observing other consoles') && guide2.includes('snaos peek <console>') && guide2.includes('snaos chat <console>') && guide2.includes('## Notes') && guide2.includes('snaos notes append'), 'guide: observing other consoles and Notes sections')
  check(guide2.includes('--yes') && guide2.includes('8 conflict') && /Never `kill`, `restart` or `ws close`/.test(guide2), 'guide: destructive command rules and exit 8')
  check(!/[\u2013\u2014]/.test(guide2) && !/[\u2013\u2014]/.test(C.USAGE), 'guide and usage carry no en or em dash')

  // --- app 2.3.0 (4b): usage and account ----------------------------------------
  check(p(['account']).command === 'account' && p(['account']).sub === 'status' && p(['account', 'ls']).sub === 'ls' && p(['account', 'use', 'secondary']).positionals[0] === 'secondary', 'account alone is account status; ls and use parse')
  check(/unknown account command "rm"/.test(usage(['account', 'rm', 'x'])) && /--provider does not apply to account status/.test(usage(['account', 'status', '--provider', 'claude'])) && /--lines does not apply to usage/.test(usage(['usage', '-n', '3'])), 'account rm is unknown; flags are checked per subcommand')
  check((await b(['usage'])).method === 'usage' && JSON.stringify((await b(['usage'])).params) === '{}' && (await b(['usage', '--provider', 'codex'])).params.provider === 'codex', 'usage params')
  check(/--provider must be claude or codex/.test(await bad(['usage', '--provider', 'custom'])) && /usage takes no argument/.test(await bad(['usage', 'claude'])), 'usage validates --provider and takes no argument')
  check((await b(['account'])).method === 'account.status' && (await b(['account', 'ls', '--provider', 'claude'])).method === 'account.ls' && /--provider must be claude/.test(await bad(['account', 'ls', '--provider', 'codex'])), 'account status and ls; only --provider claude')
  const use = await b(['account', 'use', 'Mi', 'cuenta'])
  check(use.method === 'account.use' && use.params.account === 'Mi cuenta' && /account use needs an account/.test(await bad(['account', 'use'])), 'account use joins a label of several words; no account is a usage error')
  const now = Date.UTC(2026, 9, 20, 12, 0)
  check(C.resetIn('2026-10-20T14:10:00.000Z', now) === '2h 10m' && C.resetIn('2026-10-23T16:00:00.000Z', now) === '3d 4h' && C.resetIn('2026-10-20T12:05:00.000Z', now) === '5m' && C.resetIn('2026-10-20T13:00:00.000Z', now) === '1h' && C.resetIn('2026-10-20T11:00:00.000Z', now) === 'now' && C.resetIn(null, now) === '' && C.resetIn('nope', now) === '', 'resetIn: 2h 10m, 3d 4h, 5m, 1h, now and unknown')
  const soon = new Date(Date.now() + (2 * 60 + 10) * 60_000 - 1000).toISOString()
  check(C.formatHuman('usage', { updatedAt: 1, services: null, account: { id: 'acc_a', rank: 3, slot: 'secondary', label: 'Casa' }, rows: [] }).endsWith('claude account: Casa (#3)'), 'usage human output names the account by label and #rank')
  const uh = C.formatHuman('usage', { updatedAt: 1, services: null, account: { id: 'acc_a', slot: 'primary', label: '' }, rows: [
    { id: 'claude.5h', provider: 'claude', kind: '5h', label: 'Session', percent: 42.4, resetsAt: soon, status: 'ok', planType: 'max' },
    { id: 'claude.7d', provider: 'claude', kind: '7d', label: 'Weekly', percent: 80, resetsAt: null, status: 'ok', stale: true },
    { id: 'codex.5h', provider: 'codex', kind: '5h', label: 'Session', percent: null, resetsAt: null, status: 'error' },
  ] })
  check(uh === 'claude Session         42%   resets in 2h 10m  [max]\nclaude Weekly          80%    (stale)\ncodex  Session         -     error\nclaude account: primary', 'usage human output', uh)
  check(C.formatHuman('usage', { rows: [], updatedAt: 0, services: null }) === 'no usage rows (turn them on in Settings > AI Usage)', 'usage human output without rows')
  const acc = (over) => ({ id: 'acc_a', provider: 'claude', rank: 1, slot: 'primary', label: 'Trabajo', plan: 'max', active: true, ready: true, fiveHour: { percent: 30, resetsAt: null, source: 'live' }, sevenDay: { percent: 50, resetsAt: null, source: 'live' }, ...over })
  const al = C.formatHuman('account.ls', { accounts: [acc(), acc({ id: 'acc_b', rank: 2, slot: 'secondary', label: '', plan: null, active: false, ready: false, fiveHour: { percent: 5, resetsAt: soon, source: 'parked' }, sevenDay: { percent: null, resetsAt: null, source: 'none' } })] })
  check(al === '* #1  Trabajo           max     5h 30%  7d 50%\n  #2  -                         5h 5% (resets in 2h 10m)  7d -  (capture it again on the desktop)', 'account ls human output (a #n column)', al)
  check(C.formatHuman('account.ls', { accounts: [] }).startsWith('no saved Claude accounts'), 'account ls without accounts')
  const ast = C.formatHuman('account.status', { supported: true, live: 'known', active: acc(), accounts: [acc(), acc({ id: 'acc_b', rank: 2, slot: 'secondary', label: 'Personal', active: false })], lastSwitch: { at: Date.UTC(2026, 9, 1, 9, 30), from: 'acc_b', to: 'acc_a', reason: 'cli' }, auto: { enabled: true, switchAtPercent: 99, paused: 'conflict' } })
  check(/^active: Trabajo \(#1\)\nlast switch: Personal to Trabajo \(cli, 2026-10-01 \d\d:\d\d\)\nautomatic switch: on at 99% \(paused: conflict\)$/.test(ast), 'account status human output', ast)
  check(C.formatHuman('account.status', { supported: true, live: 'unknown', active: null, accounts: [acc()], lastSwitch: null, auto: { enabled: false, switchAtPercent: 99, paused: null } }) === 'active: a Claude login that is not saved here\nautomatic switch: off' && C.formatHuman('account.status', { supported: false, accounts: [] }).includes('not supported'), 'account status with an unknown live login, and unsupported')
  check(C.formatHuman('account.use', { active: acc({ rank: 2, slot: 'secondary', label: 'Personal' }), changed: true }) === 'switched to Personal (#2)' && C.formatHuman('account.use', { active: acc({ label: '' }), changed: false }) === 'already on #1', 'account use human output (#n in parentheses only after a label)')
  const longRow = C.formatHuman('account.ls', { accounts: [acc({ label: 'MyVeryLongWorkAccount', plan: 'enterprise' })] })
  check(longRow === '* #1  MyVeryLongWorkAccount enterprise 5h 30%  7d 50%', 'account ls: a long label or plan still leaves a space before the next column', longRow)
  const unvSt = C.formatHuman('account.status', { supported: true, live: 'known', unverified: true, active: acc(), accounts: [acc()], lastSwitch: null, auto: { enabled: false, switchAtPercent: 99, paused: null } })
  check(unvSt === 'active: Trabajo (#1)\nthe live Claude login changed and is not identified yet: switches wait until a Claude console used it\nautomatic switch: off', 'account status human output while the live login is unverified', unvSt)
  check(C.USAGE.includes('snaos usage [--provider claude|codex]') && C.USAGE.includes('account use <n|id|label>'), 'USAGE lists usage and account')
  check(guide2.includes('## Usage and Claude accounts') && guide2.includes('snaos usage') && /only when the user asks/.test(guide2) && /Never `account use` unless the user asked/.test(guide2), 'guide: usage and accounts section, account use only on request')
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
    // Never the real ~/.claude or ~/.codex: the skill refresh at init reads these trees.
    skillEnv: { CLAUDE_CONFIG_DIR: path.join(dataDir, 'claude'), CODEX_HOME: path.join(dataDir, 'codex') },
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
    const n = world.pty.submits.length
    world.states.p3 = { paneId: 'p3', state: 'action', precise: true, provider: 'claude', pendingCount: 1 }
    const refused = await C.run(['send', '3', '1', '--enter'], deps(env1, out, err))
    check(refused === 9 && world.pty.submits.length === n && /waits on the user/.test(err.at(-1)), 'send to a permission menu exits 9 through the whole chain and types nothing')
    world.states.p3 = { paneId: 'p3', state: 'idle', precise: true, stateSince: Date.now() - 1000 }
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
  // app 2.3.0 end to end: services attached late (like bootstrap), a real WsNoteStore and the chat fixtures.
  {
    const run = async (argv, env = env1) => { const out = [], err = []; const code = await C.run(argv, deps(env, out, err)); return { code, out: out.join('\n'), err: err.join('\n') } }
    check((await run(['notes', '--json'])).code === 7, 'before attach the notes answer disabled (exit 7)')
    const { WsNoteStore } = load('src/main/notes/WsNoteStore.ts')
    const notesRoot = tmp('cli-notes')
    const emitted = []
    const store = new WsNoteStore({ root: () => notesRoot, emit: (e) => emitted.push(e) })
    service.attach({
      notes: store,
      chat: { locate: async (id) => (id === 'p1' ? { ok: true, path: path.join(FIX, 'claude-session.jsonl'), provider: 'claude' } : id === 'p3' ? { ok: true, path: path.join(FIX, 'codex-rollout.jsonl'), provider: 'codex' } : { ok: false, reason: 'noTranscript' }) },
    })
    const made = await run(['notes', 'new', 'hola', '--title', 'Plan', '--json'])
    const id = JSON.parse(made.out).data.note.id
    const file = path.join(notesRoot, 'w1', `${id}.md`)
    check(made.code === 0 && fs.readFileSync(file, 'utf8') === '# Plan\n\nhola' && emitted.length === 1 && emitted[0].noteId === id, 'snaos notes new writes <root>/w1/<id>.md through the store and emits once')
    check((await run(['notes', 'append', id, 'mas'])).code === 0 && fs.readFileSync(file, 'utf8').endsWith('hola\nmas'), 'snaos notes append, end to end')
    const got = await run(['notes', 'get', 'Plan'])
    check(got.code === 0 && got.out === '# Plan\n\nhola\nmas', 'snaos notes get <title> prints the raw text')
    const rev = JSON.parse((await run(['notes', 'get', id, '--json'])).out).data.note.rev
    const stale = await run(['notes', 'set', id, 'pisado', '--rev', 'r-old'])
    check(stale.code === 8 && /changed since --rev/.test(stale.err) && fs.readFileSync(file, 'utf8').endsWith('mas'), 'a stale --rev exits 8 and leaves the file alone')
    check((await run(['notes', 'set', id, 'nuevo', '--rev', rev])).code === 0 && fs.readFileSync(file, 'utf8') === 'nuevo', 'the current --rev writes')
    const lsOut = await run(['notes'])
    check(lsOut.code === 0 && lsOut.out.startsWith(id) && lsOut.out.includes('nuevo'), 'snaos notes lists them (human)')
    check((await run(['notes', 'rm', id])).code === 0 && !fs.existsSync(file) && fs.readdirSync(path.join(notesRoot, '.trash', 'w1')).some((f) => f.startsWith(id)), 'snaos notes rm moves the file under .trash/w1')
    const guarded = await store.write({ workspaceId: 'w1', noteId: id, text: 'revivida', baseRev: rev })
    check(!guarded.ok && guarded.error === 'not_found' && !fs.existsSync(file), 'a --rev guarded write on a deleted note is not_found and never brings it back')
    check((await run(['notes', 'set', id, 'otra', '--rev', rev])).code === 3 && !fs.existsSync(file), 'snaos notes set --rev on a trashed note exits 3')
    check((await store.write({ workspaceId: 'w1', noteId: id, text: 'nueva' })).ok && fs.readFileSync(file, 'utf8') === 'nueva' && fs.rmSync(file) === undefined, 'an unguarded write still creates it (Keep mine)')
    const under = await run(['notes', 'new', 'cuerpo', '--title', 'fix_login', '--json'])
    const underId = JSON.parse(under.out).data.note.id
    const underGet = await run(['notes', 'get', 'fix_login', '--json'])
    check(under.code === 0 && underGet.code === 0 && JSON.parse(underGet.out).data.note.id === underId && (await run(['notes', 'rm', 'fix_login'])).code === 0, 'a note titled fix_login (listed as fixlogin) is found by the title it was created with')
    // chat and peek through the whole chain with the fixture transcripts.
    const chat = await run(['chat', '1', '--turns', '1'])
    check(chat.code === 0 && chat.out.startsWith('--- user') && chat.out.includes('Look at this') && chat.out.endsWith('older: snaos chat p1 --before 7724'), 'snaos chat 1 --turns 1 prints the last turn and the older line', chat.out)
    const older = await run(['chat', 'p1', '--turns', '1', '--before', '7724', '--json'])
    check(older.code === 0 && JSON.parse(older.out).data.items[0].blocks[0].text === '/model opus', 'snaos chat --before pages back, end to end')
    const cx = await run(['chat', 'api:3', '--tools'])
    check(cx.code === 0 && cx.out.includes('-> ') && cx.out.includes('<- result') && cx.out.includes('Fixed the failing test.'), 'snaos chat of the Codex console with --tools', cx.out)
    world.states.p3 = { paneId: 'p3', provider: 'codex', state: 'done', precise: true, notify: false, attention: true, stateSince: Date.now() - 5000 }
    const pk = await run(['peek', '3', '--json'])
    const pd = JSON.parse(pk.out).data
    check(pk.code === 0 && pd.state === 'done' && pd.attention === true && pd.lastMessage === 'Fixed the failing test.' && Array.isArray(pd.lines), 'snaos peek 3 from console 1: state, attention and the last reply from the transcript')
    check(world.states.p3.attention === true && !world.ops.some((o) => o.kind === 'attention' && o.paneId === 'p3'), 'peeking never acknowledges for the user')
    const nochat = await run(['chat', '2'])
    check(nochat.code === 3 && /no chat for this console/.test(nochat.err), 'a console without a transcript exits 3')
    check((await run(['kill', 'srv:1'])).code === 7, 'snaos kill srv:1 (SSH protected) exits 7')
    check((await run(['ws', 'close', 'api', '--yes'])).code === 2, 'snaos ws close of its own workspace exits 2')
    check((await run(['kill', 'self'])).code === 2, 'snaos kill self exits 2')
    // 4b: usage and accounts attached late, like bootstrap (the adapter over an AccountService fake).
    check((await run(['usage'])).code === 7 && (await run(['account'])).code === 7, 'before attach usage and account answer disabled (exit 7)')
    const { ctlAccountsView } = load('src/main/cli/accountsView.ts')
    const src = fakeAccountSource()
    service.attach({ usage: fakeUsage(), accounts: ctlAccountsView(src) })
    const us = await run(['usage'])
    check(us.code === 0 && /^claude Session +42% +resets in /.test(us.out) && us.out.includes('codex  Session') && !us.out.includes('gpt-x') && us.out.endsWith('claude account: Trabajo (#1)'), 'snaos usage, end to end', us.out)
    const usj = await run(['usage', '--provider', 'claude', '--json'])
    check(usj.code === 0 && JSON.parse(usj.out).data.rows.length === 2 && !usj.out.includes('sk-ant') && !usj.out.includes('@'), 'snaos usage --provider claude --json: no token, no email')
    const as = await run(['account'])
    check(as.code === 0 && as.out.startsWith('active: Trabajo (#1)') && as.out.includes('automatic switch: on at 95%'), 'snaos account (status), end to end', as.out)
    const al = await run(['account', 'ls', '--json'])
    check(al.code === 0 && JSON.parse(al.out).data.accounts.length === 2 && !al.out.includes('@') && !al.out.includes('sk-ant'), 'snaos account ls --json: no email, no token')
    const used = await run(['account', 'use', 'secondary'])
    check(used.code === 0 && used.out === 'switched to Personal (#2)' && src.calls.length === 1 && src.calls[0].reason === 'cli', "snaos account use secondary switches with reason 'cli'", used.out)
    check((await run(['account', 'use', 'Personal'])).out === 'already on Personal (#2)' && src.calls.length === 1, 'using the live account again changes nothing')
    src.next = { ok: false, error: 'locked' }
    const lockedRun = await run(['account', 'use', 'primary'])
    check(lockedRun.code === 7 && /capture it again/.test(lockedRun.err), 'a locked login exits 7 with the hint')
    check((await run(['account', 'use', 'nadie'])).code === 3, 'an unknown account exits 3')
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
  check(service.skill('install').state === 'installed' && fs.existsSync(path.join(dataDir, 'claude', 'skills', 'snagentsos', 'SKILL.md')) && service.skill('remove').state === 'missing', 'the service skill ops use the injected CLAUDE_CONFIG_DIR (claude by default)')
  const cxSkill = path.join(dataDir, 'codex', 'skills', 'snagentsos', 'SKILL.md')
  check(service.skill('install', 'codex').state === 'installed' && service.skill('status', 'codex').target === 'codex' && fs.existsSync(cxSkill) && service.skill('status').state === 'missing', 'the service skill ops with target codex use the injected CODEX_HOME and leave Claude alone')
  check(service.skill('remove', 'codex').state === 'missing' && !fs.existsSync(cxSkill), 'the service removes the Codex skill')
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
    await moreHandlerChecks()
    await usageAccountChecks()
    await waitChecks()
    await cliEntryChecks()
    await serviceChecks()
    await shimRunChecks()
    ptyChecks()
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
    if (sockRoot) fs.rmSync(sockRoot, { recursive: true, force: true })
  }
  console.log(`PASS: ${checks} cli checks (refs, ANSI, tokens, env, runtime.json, shim static and executed, user PATH, skill, custom notify, CtlServer, handlers, chat, peek, kill, restart, rename, ws, notes, usage, account, wait, cliEntry, CliService end to end, pty tail)`)
}
main().catch((err) => {
  console.error(err)
  process.exit(1)
})
