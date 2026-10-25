// Team runs, the process side (app 2.7.0, B2): treeKill (a real child with a real grandchild,
// `ping` (detached, out of the kill-on-close job) or `sleep`, killed with the whole tree, and the
// control that killing the child alone leaves it alive; a dead pid; the injected taskkill and kill),
// procStartTime (the test process itself and a child, injected probe outputs), agentCli
// (resolveAgentCli skip rules, .exe before .cmd, spawnTarget for a .cmd), teamArgv (argv snapshots
// per provider x profile x new/resume, with the isolation flags and the protect rules on every
// Claude line, claudePathRule, grants, isGrantable, grantPatternOf twins) and teamTools (the 5.3
// table, allowedFor, teamToolsGuide, teamChannelText, parseTeamBlock fences and refs).
// Same esbuild + vm harness as test-status.cjs: no Electron, no user data, never a real agent.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const win = process.platform === 'win32'
let checks = 0
function check(condition, label, extra) { assert.ok(condition, extra === undefined ? label : `${label}: ${JSON.stringify(extra)}`); checks++ }
// Values built inside the vm have another realm's prototypes; compare as JSON.
const json = (v) => JSON.stringify(v ?? null)
function same(actual, expected, label) { assert.deepEqual(JSON.parse(json(actual)), expected, label); checks++ }
const EXTERNAL = ['electron', 'ws', 'node-pty', '@xterm/headless', '@xterm/addon-serialize', '@xterm/addon-unicode11']
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: EXTERNAL, alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, structuredClone, TextEncoder, TextDecoder, ...overrides })
  return mod.exports
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const DASH_RE = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`)

// --- treeKill --------------------------------------------------------------------------------

/**
 * A node child that starts a long-lived grandchild and prints its pid (POSIX: its own process group). On Windows the
 * grandchild is detached: libuv puts every non-detached child in its parent's kill-on-close job, so killing the child
 * alone would take it down too and the checks could not tell /T from no /T (the control below proves the difference).
 * On POSIX it stays in the child's group (a detached one would leave it). Bounded (ping -n, sleep) so a failed run
 * never leaves a process behind for good.
 */
async function startTree() {
  const grandchild = win
    ? "require('child_process').spawn('ping', ['-n', '300', '127.0.0.1'], { stdio: 'ignore', windowsHide: true, detached: true })"
    : "require('child_process').spawn('sleep', ['300'], { stdio: 'ignore' })"
  const script = `const c = ${grandchild}; c.unref(); console.log(String(c.pid)); setInterval(() => {}, 1000)`
  const startedAt = Date.now()
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'], detached: !win, windowsHide: true })
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  const grand = await new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error('the child never printed its grandchild pid')), 15000)
    child.stdout.on('data', (c) => {
      buf += c
      const m = /(\d+)\s/.exec(buf)
      if (m) { clearTimeout(timer); resolve(Number(m[1])) }
    })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
  })
  return { child, grand, exited, startedAt }
}

async function gone(T, pid, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (!T.pidAlive(pid)) return true
    await sleep(100)
  }
  return !T.pidAlive(pid)
}

async function treeChecks() {
  const T = load('src/main/proc/treeKill.ts')
  const trees = []
  try {
    const a = await startTree()
    trees.push(a)
    check(T.pidAlive(a.child.pid) && T.pidAlive(a.grand), 'a real child with a real grandchild (ping / sleep) is alive')
    const probe = await T.procStartTime(a.child.pid)
    check(probe && probe.image === 'node' && Math.abs(probe.at - a.startedAt) < 10_000, 'procStartTime of the child: node, started when it was spawned', probe)
    check(T.treeKillSync(a.child.pid) === true, 'treeKillSync answers true')
    await Promise.race([a.exited, sleep(10_000)])
    check(await gone(T, a.child.pid), 'the child is gone')
    check(await gone(T, a.grand), 'the grandchild died with the whole tree')
    check(T.treeKillSync(a.child.pid) === true, 'a dead pid is ok (taskkill 128 / ESRCH)')
    check((await T.procStartTime(a.child.pid)) === null, 'procStartTime of a dead pid is null')

    const b = await startTree()
    trees.push(b)
    check(T.signalTree(b.child.pid, 'SIGTERM') === true, win ? 'signalTree on Windows is the tree kill' : 'signalTree SIGTERM reaches the process group')
    await Promise.race([b.exited, sleep(10_000)])
    check(await gone(T, b.child.pid) && (await gone(T, b.grand)), 'signalTree stops the child and the grandchild')

    // Control: killing the child alone (taskkill without /T, or kill(pid) on POSIX) leaves the grandchild alive, so the
    // checks above pass only because the tree kill reaches it.
    const c = await startTree()
    trees.push(c)
    if (win) {
      const res = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(c.child.pid), '/F'], { windowsHide: true, timeout: 10_000 })
      check(res.status === 0, 'control: taskkill /PID <child> /F (no /T) kills the child')
    } else process.kill(c.child.pid, 'SIGKILL')
    await Promise.race([c.exited, sleep(10_000)])
    check(await gone(T, c.child.pid), 'control: the child alone is gone')
    await sleep(500)
    check(T.pidAlive(c.grand), win ? 'control: without /T the detached grandchild survives (only /T reaches it)' : 'control: kill(pid) alone leaves the grandchild of the group alive')
  } finally {
    for (const t of trees) {
      try { T.treeKillSync(t.child.pid) } catch { /* already gone */ }
      try { process.kill(t.grand, 'SIGKILL') } catch { /* already gone */ }
    }
  }

  // The test process itself (decision 64): the image is node, the time is when it started.
  const self = await T.procStartTime(process.pid)
  const started = Date.now() - process.uptime() * 1000
  check(self && self.image === 'node' && Math.abs(self.at - started) < 10_000, 'procStartTime of the test process itself', { self, started })
  check((await T.procStartTime(0)) === null && (await T.procStartTime(-5)) === null && (await T.procStartTime(1.5)) === null, 'procStartTime of a bad pid is null')

  // Injected taskkill (Windows) and kill (POSIX).
  const calls = []
  const fakeSpawnSync = (status) => (file, args, opts) => { calls.push({ file, args, opts }); return { status } }
  check(T.treeKillSync(4242, { platform: 'win32', spawnSync: fakeSpawnSync(0) }) === true, 'taskkill exit 0: true')
  same(/^[A-Za-z]:\\.*\\System32\\taskkill\.exe$/i.test(calls[0].file) && calls[0].args, ['/PID', '4242', '/T', '/F'], '<SystemRoot>\\System32\\taskkill.exe /PID <pid> /T /F (never a PATH or cwd lookup)')
  check(calls[0].opts.windowsHide === true, 'taskkill runs hidden')
  check(T.treeKillSync(4242, { platform: 'win32', spawnSync: fakeSpawnSync(128) }) === true, 'taskkill exit 128 (already dead): true')
  check(T.treeKillSync(4242, { platform: 'win32', spawnSync: fakeSpawnSync(1) }) === false, 'taskkill exit 1: false')
  check(T.signalTree(4242, 'SIGTERM', { platform: 'win32', spawnSync: fakeSpawnSync(0) }) === true && calls.at(-1).args.includes('/T'), 'signalTree on win32 is taskkill /T /F')
  const n = calls.length
  check(T.treeKillSync(0, { platform: 'win32', spawnSync: fakeSpawnSync(0) }) === false && T.treeKillSync(NaN, { platform: 'win32', spawnSync: fakeSpawnSync(0) }) === false && calls.length === n, 'a bad pid is never signalled')
  const err = (code) => Object.assign(new Error(code), { code })
  const kills = []
  const groupGone = (pid, sig) => { kills.push([pid, sig]); if (pid < 0) throw err('ESRCH') }
  check(T.treeKillSync(77, { platform: 'linux', kill: groupGone }) === true, 'POSIX: no group, the pid alone')
  same(kills, [[-77, 'SIGKILL'], [77, 'SIGKILL']], 'POSIX: kill(-pid, SIGKILL), then kill(pid)')
  kills.length = 0
  check(T.signalTree(77, 'SIGTERM', { platform: 'darwin', kill: (pid, sig) => kills.push([pid, sig]) }) === true, 'POSIX signalTree signals the group')
  same(kills, [[-77, 'SIGTERM']], 'the group gets SIGTERM, nothing else')
  check(T.treeKillSync(77, { platform: 'linux', kill: () => { throw err('ESRCH') } }) === true, 'POSIX: a pid already gone counts as killed')
  check(T.treeKillSync(77, { platform: 'linux', kill: () => { throw err('EPERM') } }) === false, 'POSIX: EPERM is not killed')
  check(T.pidAlive(5, () => true) === true && T.pidAlive(5, () => { throw err('EPERM') }) === true && T.pidAlive(5, () => { throw err('ESRCH') }) === false && T.pidAlive(0, () => true) === false, 'pidAlive: kill 0, EPERM alive, ESRCH dead')

  // Injected probe outputs.
  const execs = []
  const fakeExec = (stdout, error = null) => (file, args, opts, cb) => { execs.push({ file, args, opts }); cb(error, stdout, '') }
  const w = await T.procStartTime(4242, { platform: 'win32', execFile: fakeExec('2026-10-24T13:00:00.1234567Z|node\r\n') })
  same(w, { at: Date.UTC(2026, 9, 24, 13, 0, 0, 123), image: 'node' }, 'win32: the round-trip UTC start time and the process name')
  check(/^[A-Za-z]:\\.*\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i.test(execs[0].file) && json(execs[0].args.slice(0, 3)) === json(['-NoProfile', '-NonInteractive', '-Command']) && execs[0].args[3].includes('Get-Process -Id 4242 -ErrorAction Stop') && execs[0].opts.timeout === 5000 && execs[0].opts.windowsHide === true, 'win32: Get-Process through powershell.exe, hidden, 5 s', execs[0])
  check((await T.procStartTime(4242, { platform: 'win32', execFile: fakeExec('2026-10-24T13:00:00.1234567Z|explorer\r\n') })) === null, 'win32: another image is no match')
  check((await T.procStartTime(4242, { platform: 'win32', execFile: fakeExec('2026-10-24T13:00:00Z|Codex\r\n') })).image === 'codex', 'win32: image names compare lowercased, no fraction ok')
  check((await T.procStartTime(4242, { platform: 'win32', execFile: fakeExec('', err('ENOENT')) })) === null && (await T.procStartTime(4242, { platform: 'win32', execFile: fakeExec('Get-Process : Cannot find a process') })) === null, 'win32: a failed or garbled probe is null')
  const d = await T.procStartTime(77, { platform: 'darwin', execFile: fakeExec('Sat Oct 24 10:00:00 2026     /usr/local/bin/claude\n') })
  same(d, { at: new Date(2026, 9, 24, 10, 0, 0).getTime(), image: 'claude' }, 'darwin: ps lstart (local time) and comm')
  const ps = execs.at(-1)
  check(ps.file === 'ps' && json(ps.args) === json(['-o', 'lstart=', '-o', 'comm=', '-p', '77']) && ps.opts.env.LC_ALL === 'C', 'darwin: ps -o lstart= -o comm= -p <pid> with LC_ALL=C', ps)
  check((await T.procStartTime(77, { platform: 'darwin', execFile: fakeExec('Sat Oct 24 10:00:00 2026 /sbin/launchd\n') })) === null, 'darwin: another image is no match')
}

// --- agentCli --------------------------------------------------------------------------------

function agentCliChecks() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-treekill-'))
  try {
    const userData = path.join(tmp, 'userData')
    const electron = { app: { isPackaged: false, getPath: (name) => (name === 'appData' ? tmp : name === 'exe' ? path.join(tmp, 'app.exe') : userData), getVersion: () => '2.7.0', commandLine: { hasSwitch: () => false }, on() {} } }
    const A = load('src/main/teams/agentCli.ts', { require: (id) => (id === 'electron' ? electron : require(id)), process: { ...process, env: {}, argv: ['electron'] } })
    const probes = []
    const has = (files) => (f) => { probes.push(f); return files.includes(f) }
    // Windows rules on any OS (the platform argument picks the path rules).
    const statusBin = 'C:\\Users\\u\\AppData\\Roaming\\snagentsos\\status-bin'
    const dataBin = 'C:\\Users\\u\\AppData\\Roaming\\snagentsos\\bin'
    const PATH = [`${statusBin}`, '.', 'relative\\bin', '"C:\\Program Files\\nodejs"', 'C:\\npm', '\\\\srv\\share\\bin', 'C:\\Users\\u\\.local\\bin', dataBin, ''].join(';')
    const files = [`${statusBin}\\codex.cmd`, '.\\codex.exe', 'relative\\bin\\codex.exe', 'C:\\npm\\codex.cmd', '\\\\srv\\share\\bin\\codex.exe', 'C:\\Users\\u\\.local\\bin\\codex.exe', `${dataBin}\\claude.exe`, 'C:\\Program Files\\nodejs\\claude.cmd']
    const skipDirs = ['c:\\users\\u\\appdata\\roaming\\snagentsos\\STATUS-BIN\\', dataBin]
    const cx = A.resolveAgentCli('codex', { Path: PATH }, { platform: 'win32', isFile: has(files), skipDirs })
    same(cx, { file: 'C:\\Users\\u\\.local\\bin\\codex.exe', args: [], kind: 'exe' }, 'win32: an .exe later in PATH wins over an earlier .cmd; the app shim, relative dirs and UNC are skipped')
    check(!probes.some((p) => /status-bin/i.test(p) || p.startsWith('.') || p.startsWith('relative') || p.startsWith('\\\\') || p.startsWith(dataBin)), 'win32: skipped folders are never even probed', probes)
    probes.length = 0
    const cl = A.resolveAgentCli('claude', { PATH }, { platform: 'win32', isFile: has(files), skipDirs })
    same(cl, { file: 'C:\\Program Files\\nodejs\\claude.cmd', args: [], kind: 'cmd' }, 'win32: dataDir/bin is skipped; a quoted PATH entry; a .cmd when no .exe exists')
    check(A.resolveAgentCli('claude', { PATH: 'C:\\none' }, { platform: 'win32', isFile: has(files), skipDirs }) === null && A.resolveAgentCli('codex', {}, { platform: 'win32', isFile: has(files), skipDirs }) === null, 'win32: not found, and no PATH at all: null')
    const px = A.resolveAgentCli('claude', { PATH: '/home/u/.config/snagentsos/bin:./bin:bin:/usr/local/bin:/usr/bin' }, { platform: 'linux', isFile: has(['/home/u/.config/snagentsos/bin/claude', './bin/claude', 'bin/claude', '/usr/bin/claude']), skipDirs: ['/home/u/.config/snagentsos/bin/'] })
    same(px, { file: '/usr/bin/claude', args: [], kind: 'posix' }, 'POSIX: the first absolute, not skipped folder that has it')

    // The default skip list: statusBinDirs() and <dataDir>/bin (host path rules).
    const hostStatus = path.join(userData, 'status-bin')
    const hostBin = path.join(userData, 'bin')
    const other = path.join(tmp, 'tools')
    const ext = win ? '.exe' : ''
    const hostFiles = [path.join(hostStatus, `codex${win ? '.cmd' : ''}`), path.join(hostBin, `codex${ext}`), path.join(other, `codex${ext}`)]
    const def = A.resolveAgentCli('codex', { PATH: [hostStatus, hostBin, other].join(path.delimiter) }, { isFile: has(hostFiles) })
    check(def && def.file === path.join(other, `codex${ext}`), 'by default the status-bin and dataDir()/bin folders are skipped', def)

    // spawnTarget: an exe directly; a .cmd through cmd.exe /d /s /c with the line quoted once, verbatim.
    same(A.spawnTarget({ file: '/usr/bin/claude', args: ['--x'], kind: 'posix' }, ['-p', '--verbose']), { file: '/usr/bin/claude', args: ['--x', '-p', '--verbose'], verbatim: false }, 'spawnTarget of an exe or a POSIX file: file, its args, then argv')
    const t = A.spawnTarget({ file: 'C:\\Program Files\\nodejs\\codex.cmd', args: [], kind: 'cmd' }, ['exec', '--json', '-c', 'approval_policy="never"', '-'])
    check(/\\System32\\cmd\.exe$/i.test(t.file) && t.verbatim === true, 'a .cmd runs through <SystemRoot>\\System32\\cmd.exe, verbatim', t)
    same(t.args, ['/d', '/s', '/c', '""C:\\Program Files\\nodejs\\codex.cmd" exec --json -c "approval_policy=""never""" -"'], 'cmd /d /s /c "<quoted line>"')
    check(A.quoteForCmd('') === '""' && A.quoteForCmd('plain') === 'plain' && A.quoteForCmd('a&b') === '"a&b"' && A.quoteForCmd('say "hi"') === '"say ""hi"""' && A.quoteForCmd('(x)') === '"(x)"', 'quoteForCmd (paperclip, verbatim)')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// --- teamArgv --------------------------------------------------------------------------------

function argvChecks() {
  const G = load('src/shared/teamArgv.ts')
  const SID = 'b3a97cac-b7f6-4fc1-8714-caef9a2eb42e'
  const TID = '01a16976-a319-7192-961e-2c0dabde59b3'
  const DATA = 'C:\\Users\\u\\AppData\\Roaming\\snagentsos'
  const sys = `${DATA}\\teams\\tm-0123456789ab\\runs\\r-0123456789ab.system.md`
  const cwd = 'C:\\repos\\api'
  const protect = { readDeny: [`${DATA}\\runtime.json`], writeDeny: [`${DATA}\\teams\\`, `${DATA}\\trusted-teams.json`, `${DATA}\\runtime.json`] }
  const D = '//c/Users/u/AppData/Roaming/snagentsos'
  const both = (tools, p) => tools.flatMap((t) => [`${t}(${D}/${p})`, `${t}(${D}/${p}/**)`])
  const W = ['Edit', 'Write', 'MultiEdit']
  const PROTECT = [...both(['Read'], 'runtime.json'), ...W.map((t) => `${t}(${D}/teams/**)`), ...both(W, 'trusted-teams.json'), ...both(W, 'runtime.json')]
  const ISO = ['--setting-sources', 'user', '--strict-mcp-config']
  const HEAD = ['-p', '--output-format', 'stream-json', '--verbose', ...ISO]
  const TOTAL_DENY = ['Bash(git push:*)', 'Bash(git merge:*)', 'Bash(git worktree:*)', 'Bash(git update-ref:*)', 'PowerShell(git push:*)', 'PowerShell(git merge:*)', 'PowerShell(git worktree:*)', 'PowerShell(git update-ref:*)']
  const RO_ALLOW = ['Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)', 'Bash(git status:*)', 'PowerShell(git log:*)', 'PowerShell(git diff:*)', 'PowerShell(git show:*)', 'PowerShell(git status:*)']
  // E10 SPIKE (deviation of decision 2): only the Bash rule; PowerShell would run snaos.cmd, whose %* cmd.exe re-parses.
  const TEAM = ['Bash(snaos team:*)']
  same(G.CLAUDE_ISOLATION_FLAGS, ISO, 'CLAUDE_ISOLATION_FLAGS')
  same(G.CLAUDE_TOTAL_DENY, TOTAL_DENY, 'CLAUDE_TOTAL_DENY has the PowerShell twin of every Bash rule (decision 2)')
  same(G.CLAUDE_TEAM_TOOLS, TEAM, 'CLAUDE_TEAM_TOOLS: the Bash rule only, never PowerShell(snaos team:*)')

  const claude = (profile, session, extra = {}) => G.teamArgv({ provider: 'claude', profile, session, systemFile: sys, cwd, protect, ...extra })
  const grants = ['Bash(npm test:*)', 'PowerShell(npm test:*)', 'Bash(git push:*)', 'Task', 'mcp__github__create_issue', 'Bash(npm test:*)']
  const snaps = {
    'claude total new': [claude('total', { kind: 'new', sessionId: SID }, { model: 'sonnet', effort: 'medium', grants }),
      [...HEAD, '--session-id', SID, '--model', 'sonnet', '--effort', 'medium', '--append-system-prompt-file', sys, '--permission-mode', 'bypassPermissions', '--disallowedTools', ...TOTAL_DENY, ...PROTECT]],
    'claude total resume': [claude('total', { kind: 'resume', sessionId: SID }),
      [...HEAD, '--resume', SID, '--append-system-prompt-file', sys, '--permission-mode', 'bypassPermissions', '--disallowedTools', ...TOTAL_DENY, ...PROTECT]],
    'claude readonly new': [claude('readonly', { kind: 'new', sessionId: SID }, { model: 'opus', effort: 'high', grants }),
      [...HEAD, '--session-id', SID, '--model', 'opus', '--effort', 'high', '--append-system-prompt-file', sys, '--permission-mode', 'dontAsk', '--allowedTools', ...RO_ALLOW, ...TEAM, 'Bash(npm test:*)', 'PowerShell(npm test:*)', '--disallowedTools', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', ...PROTECT]],
    'claude readonly resume': [claude('readonly', { kind: 'resume', sessionId: SID }, { model: 'haiku' }),
      [...HEAD, '--resume', SID, '--model', 'haiku', '--append-system-prompt-file', sys, '--permission-mode', 'dontAsk', '--allowedTools', ...RO_ALLOW, ...TEAM, '--disallowedTools', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', ...PROTECT]],
    'claude custom new': [claude('custom', { kind: 'new', sessionId: SID }, { allowedTools: ['Read', 'Edit', 'Bash(npm test:*)', 'Read', 'bad tool'], grants: ['Bash(npm run:*)', 'Bash(snaos team:*)', 'Agent'] }),
      [...HEAD, '--session-id', SID, '--append-system-prompt-file', sys, '--permission-mode', 'dontAsk', '--allowedTools', 'Read', 'Edit', 'Bash(npm test:*)', ...TEAM, 'Bash(npm run:*)', '--disallowedTools', ...TOTAL_DENY, ...PROTECT]],
    'claude custom resume': [claude('custom', { kind: 'resume', sessionId: SID }, { allowedTools: ['Grep'] }),
      [...HEAD, '--resume', SID, '--append-system-prompt-file', sys, '--permission-mode', 'dontAsk', '--allowedTools', 'Grep', ...TEAM, '--disallowedTools', ...TOTAL_DENY, ...PROTECT]],
  }
  // A role or a grant that names the CLI through PowerShell never reaches the allow list (snaos.cmd, cmd.exe).
  const psCli = ['PowerShell(snaos team:*)', 'PowerShell(snaos:*)', 'PowerShell(SNAOS.CMD team:*)', 'PowerShell(& snaos team:*)', 'PowerShell(C:/Users/u/bin/snaos.cmd team:*)', 'PowerShell(sna:*)']
  // A role's own Bash rule for the CLI goes too: Git Bash hands snaos.cmd to cmd.exe as well, and Bash(snaos team:*) is always there.
  snaps['claude custom with PowerShell CLI rules'] = [claude('custom', { kind: 'new', sessionId: SID }, { allowedTools: ['Read', ...psCli, 'Bash(snaos:*)', 'Bash(snaos.cmd team:*)', 'Bash(npm test:*)'], grants: ['PowerShell(snaos team:*)', 'PowerShell(npm test:*)'] }),
    [...HEAD, '--session-id', SID, '--append-system-prompt-file', sys, '--permission-mode', 'dontAsk', '--allowedTools', 'Read', 'Bash(npm test:*)', ...TEAM, 'PowerShell(npm test:*)', '--disallowedTools', ...TOTAL_DENY, ...PROTECT]]
  snaps['claude readonly with a PowerShell CLI grant'] = [claude('readonly', { kind: 'new', sessionId: SID }, { grants: [...psCli, 'Bash(snaos team:*)'] }),
    [...HEAD, '--session-id', SID, '--append-system-prompt-file', sys, '--permission-mode', 'dontAsk', '--allowedTools', ...RO_ALLOW, ...TEAM, '--disallowedTools', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', ...PROTECT]]
  const allowOf = (argv) => (argv.includes('--allowedTools') ? argv.slice(argv.indexOf('--allowedTools') + 1, argv.indexOf('--disallowedTools')) : [])
  for (const [label, [res, expected]] of Object.entries(snaps)) {
    same(res.argv, expected, `argv snapshot: ${label}`)
    check(res.reportsByBlock === false && res.instructionsInStdin === false && res.sandbox === undefined, `${label}: Claude reports through the CLI, instructions by file`)
    check(json(res.argv.slice(4, 7)) === json(ISO) && PROTECT.every((r) => res.argv.includes(r)), `${label}: the isolation flags and every protect rule are on the line`)
    const allow = allowOf(res.argv)
    check(!allow.some((a) => /^PowerShell\(.*snaos|^Bash\(.*snaos\.(?:cmd|bat)/i.test(a)) && !res.argv.includes('PowerShell(snaos team:*)'), `${label}: no PowerShell rule for the CLI (nor a Bash one for snaos.cmd) anywhere on the line`, allow)
    if (!label.startsWith('claude total')) check(allow.includes('Bash(snaos team:*)'), `${label}: the allow list carries Bash(snaos team:*)`)
  }
  // A plan run of any role is readonly: the same allow list, Bash only.
  for (const permission of ['total', 'custom', 'readonly']) {
    const plan = claude(G.effectiveProfile(permission, 'plan'), { kind: 'new', sessionId: SID })
    check(allowOf(plan.argv).includes('Bash(snaos team:*)') && !plan.argv.some((a) => /^PowerShell\(snaos/i.test(a)), `a plan run of a ${permission} role: Bash(snaos team:*) only`)
  }
  const noProtect = G.teamArgv({ provider: 'claude', profile: 'total', session: { kind: 'new', sessionId: SID }, cwd })
  check(!noProtect.argv.some((a) => a.includes('//')) && !noProtect.argv.includes('--append-system-prompt-file'), 'without protect nor systemFile: no path rule and no system flag')
  check(json(claude('readonly', { kind: 'new', sessionId: SID }, { model: 'default', effort: 'auto' }).argv.slice(7, 11)) === json(['--session-id', SID, '--append-system-prompt-file', sys]), "model 'default' and an effort outside the allowlist are left out")
  const evil = claude('total', { kind: 'new', sessionId: SID }, { model: 'opus; calc.exe', effort: 'high && calc' }).argv
  check(!evil.some((a) => a.includes('calc')), 'a model or effort that fails its allowlist never reaches argv')
  let threw = 0
  for (const session of [{ kind: 'new' }, { kind: 'resume', sessionId: 'not-a-uuid' }, { kind: 'resume', sessionId: `${SID} --x` }]) {
    try { G.teamArgv({ provider: 'claude', profile: 'total', session, cwd }) } catch { threw++ }
  }
  try { G.teamArgv({ provider: 'codex', profile: 'total', session: { kind: 'resume', sessionId: '-c x' }, cwd }) } catch { threw++ }
  check(threw === 4, 'a missing or non-UUID session id throws (Claude new needs one; never a flag in argv)')

  const codex = (profile, session, extra = {}) => G.teamArgv({ provider: 'codex', profile, session, cwd, systemFile: sys, protect, grants, allowedTools: ['Read'], ...extra })
  const tune = ['-m', 'gpt-6-luna', '-c', 'model_reasoning_effort="low"']
  const cx = {
    'codex total new': [codex('total', { kind: 'new' }, { model: 'gpt-6-luna', effort: 'low' }), ['exec', '--json', '--skip-git-repo-check', '-C', cwd, ...tune, '-c', 'approval_policy="never"', '-s', 'danger-full-access', '-'], 'danger-full-access', false, true],
    'codex total resume': [codex('total', { kind: 'resume', sessionId: TID }, { model: 'gpt-6-luna', effort: 'low' }), ['exec', 'resume', TID, '--json', '--skip-git-repo-check', ...tune, '-c', 'approval_policy="never"', '-c', 'sandbox_mode="danger-full-access"', '-'], 'danger-full-access', false, false],
    'codex readonly new': [codex('readonly', { kind: 'new' }), ['exec', '--json', '--skip-git-repo-check', '-C', cwd, '-c', 'approval_policy="never"', '-s', 'read-only', '-'], 'read-only', true, true],
    'codex readonly resume': [codex('readonly', { kind: 'resume', sessionId: TID }), ['exec', 'resume', TID, '--json', '--skip-git-repo-check', '-c', 'approval_policy="never"', '-c', 'sandbox_mode="read-only"', '-'], 'read-only', true, false],
    'codex custom new': [codex('custom', { kind: 'new' }, { model: 'gpt-6-luna', effort: 'low' }), ['exec', '--json', '--skip-git-repo-check', '-C', cwd, ...tune, '-c', 'approval_policy="never"', '-s', 'read-only', '-'], 'read-only', true, true],
    'codex custom resume': [codex('custom', { kind: 'resume', sessionId: TID }, { effort: 'xhigh' }), ['exec', 'resume', TID, '--json', '--skip-git-repo-check', '-c', 'model_reasoning_effort="xhigh"', '-c', 'approval_policy="never"', '-c', 'sandbox_mode="read-only"', '-'], 'read-only', true, false],
  }
  for (const [label, [res, expected, sandbox, block, instr]] of Object.entries(cx)) {
    same(res.argv, expected, `argv snapshot: ${label}`)
    check(res.sandbox === sandbox && res.reportsByBlock === block && res.instructionsInStdin === instr, `${label}: sandbox ${sandbox}, block ${block}, instructions in stdin ${instr}`, res)
  }
  check(!Object.values(cx).some(([res]) => res.argv.some((a) => a.includes('//') || a === '-a' || a.includes('Read') || a.includes('system.md'))), 'Codex: no -a, no tool lists, no protect rules, no system file (S4)')
  check(json(codex('total', { kind: 'new' }, { model: 'bad model!', effort: 'max' }).argv.slice(5, 7)) === json(['-c', 'approval_policy="never"']), 'Codex: a model or effort outside its allowlist is left out')

  same(['total', 'readonly', 'custom'].map((p) => G.effectiveProfile(p, 'plan')), ['readonly', 'readonly', 'readonly'], 'a plan run is always readonly')
  same(['exec', 'qa', 'lead', 'free'].map((m) => G.effectiveProfile('total', m)), ['total', 'total', 'total', 'total'], 'other modes keep the role profile')
  check(G.roleWrites('total') && G.roleWrites('custom') && !G.roleWrites('readonly'), 'roleWrites: total and custom')

  check(G.claudePathRule('Read', 'C:\\Users\\u\\x.json') === 'Read(//c/Users/u/x.json)', 'claudePathRule: a drive path in its POSIX form')
  check(G.claudePathRule('Edit', 'D:\\data\\teams\\', '/**') === 'Edit(//d/data/teams/**)' && G.claudePathRule('Write', 'D:/data/teams', '/**') === 'Write(//d/data/teams/**)', 'claudePathRule: the folder glob, either separator')
  check(G.claudePathRule('MultiEdit', '/home/u/.config/snagentsos/runtime.json') === 'MultiEdit(//home/u/.config/snagentsos/runtime.json)', 'claudePathRule: a POSIX path')

  const grantable = ['Read', 'Edit', 'WebFetch', 'Bash(npm test:*)', 'Bash(git log:*)', 'PowerShell(Get-ChildItem:*)', 'Bash(git pushx:*)', 'Bash(npm run build)']
  const refused = ['Bash(git push:*)', 'PowerShell(git push --force:*)', 'Bash(git push)', 'Bash(git:*)', 'Bash(gi:*)', 'Bash(:*)', 'Bash(*)', 'Bash(npm *)', 'Bash', 'PowerShell', 'Bash(git  merge:*)', 'PowerShell(GIT UPDATE-REF:*)', 'Bash(git -C:*)', 'PowerShell(git -c x=y:*)', 'Bash(git --git-dir=x status)', 'mcp__x', 'mcp__github__create_issue', 'Task', 'Agent', 'Task(explore)', 'bad tool', 'Bash(echo "x")', '']
  check(grantable.every(G.isGrantable), 'isGrantable: plain tools and shell prefixes', grantable.filter((t) => !G.isGrantable(t)))
  check(!refused.some(G.isGrantable), 'isGrantable refuses git push / merge / worktree / update-ref, a bare or wildcard shell, mcp__x, Task and Agent', refused.filter(G.isGrantable))
  const cliRules = [...psCli, 'Bash(snaos team:*)', 'Bash(snaos:*)', 'Bash(snaos ls)', 'PowerShell(& $env:SNAOS_CLI team:*)',
    'PowerShell(&snaos team:*)', 'PowerShell(. snaos team:*)', 'PowerShell(snaos.c:*)', 'PowerShell(SNAOS.CM:*)', 'PowerShell(C:/Users/u/bin/sn:*)', 'PowerShell(C:/Users/u/bin/:*)', 'PowerShell(.:*)']
  check(!cliRules.some(G.isGrantable) && G.isGrantable('PowerShell(snap list:*)') && G.isGrantable('Bash(snake:*)') && G.isGrantable('PowerShell(./build.cmd:*)') && G.isGrantable('PowerShell(. ./env.ps1:*)'), 'isGrantable never grants a shell rule that names the CLI (Bash(snaos team:*) is always there; PowerShell would reach snaos.cmd)', cliRules.filter(G.isGrantable))
  same(G.grantPatternOf({ tool: 'PowerShell', input: { command: 'snaos team comment t-1 x&calc' } }), [], 'a PowerShell denial of snaos team grants nothing (never PowerShell(snaos team:*))')
  same(G.grantPatternOf({ tool: 'PowerShell', input: { command: 'snaos.cmd team show --json' } }), [], 'nor through the .cmd name')
  same(G.grantPatternOf({ tool: 'PowerShell', input: { command: '. snaos team comment t-1 x&calc' } }), [], 'nor through the dot-source operator (`. snaos`, both words plain)')
  same(G.grantPatternOf({ tool: 'PowerShell', input: { command: 'snaos.c' } }), [], 'nor a one-word prefix that grows into snaos.cmd')
  same(G.grantPatternOf({ tool: 'Bash', input: { command: 'npm test -- --watch' } }), ['Bash(npm test:*)', 'PowerShell(npm test:*)'], 'a Bash denial: both twins of its first two words')
  same(G.grantPatternOf({ tool: 'PowerShell', input: { command: 'Get-ChildItem src\nmore' } }), ['Bash(Get-ChildItem src:*)', 'PowerShell(Get-ChildItem src:*)'], 'a PowerShell denial: both twins too (decision 2), first line only')
  same(G.grantPatternOf({ tool: 'Bash', input: { command: 'ls | grep x' } }), ['Bash(ls:*)', 'PowerShell(ls:*)'], 'the words stop at a pipe')
  same(G.grantPatternOf({ tool: 'Bash', input: { command: 'git push origin main' } }), [], 'a git push denial is never grantable')
  same(G.grantPatternOf({ tool: 'Bash', input: { command: 'git -C /repo log -1' } }), [], 'a git denial with a global option first is never grantable (git -C <dir> push would pass)')
  same(G.grantPatternOf({ tool: 'Bash', input: { command: '"C:\\x\\tool.exe" run' } }), [], 'a quoted first word: nothing grantable')
  same(G.grantPatternOf({ tool: 'Bash' }), [], 'a shell denial without a command: nothing')
  const denied = fs.readFileSync(path.join(__dirname, 'fixtures', 'teams', 'claude-denied.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.type === 'result').permission_denials[0]
  same(G.grantPatternOf({ tool: denied.tool_name, input: denied.tool_input }), ['Write'], 'the claude-denied fixture: the Write denial grants Write')
  same(['mcp__x__y', 'Task', 'Agent'].map((tool) => G.grantPatternOf({ tool })), [[], [], []], 'mcp__x, Task and Agent denials grant nothing')
}

// --- teamTools -------------------------------------------------------------------------------

function toolsChecks() {
  const K = load('src/shared/teamTools.ts')
  const P = load('src/shared/ctl-protocol.ts')
  const names = K.TEAM_TOOLS.map((t) => t.name)
  same(names, ['show', 'tasks', 'task.get', 'task.create', 'task.update', 'comment', 'note', 'ask', 'needs', 'plan', 'review', 'verdict', 'done', 'approve', 'hire'], 'the 15 tools of 5.3, in order')
  check(K.TEAM_TOOLS.every((t) => t.method === `team.${t.name}`) && json(K.TEAM_CTL_METHODS) === json(K.TEAM_TOOLS.map((t) => t.method)), 'method = team.<name>; TEAM_CTL_METHODS follows the table')
  check(K.TEAM_CTL_METHODS.every((m) => P.CTL_METHODS.includes(m)), 'every team method is in CTL_METHODS (the server lets it reach the handler)')
  same(K.TEAM_TOOLS.filter((t) => !t.write).map((t) => t.name), ['show', 'tasks', 'task.get'], 'reads: show, tasks, task get')
  same(K.TEAM_TOOLS.filter((t) => t.terminal).map((t) => [t.name, t.terminal]), [['ask', 'ask'], ['needs', 'needs'], ['plan', 'plan'], ['review', 'review'], ['verdict', 'verdict'], ['done', 'done'], ['approve', 'approvePlan'], ['hire', 'hire']], 'terminals and their TerminalTool')
  check(K.TEAM_TOOLS.every((t) => t.usage.startsWith(`snaos team ${t.name.replace('.', ' ')}`) && t.summary.length > 0 && !DASH_RE.test(t.usage + t.summary)), 'every usage is its CLI line; summaries English without dashes')
  check(K.teamTool('team.plan').terminal === 'plan' && K.teamTool('team.nope') === null && K.teamTool('plan') === null, 'teamTool by method')
  check(K.isTeamMethod('team.show') && !K.isTeamMethod('ping') && !K.isTeamMethod('team.') && !K.isTeamMethod('team.task'), 'isTeamMethod')

  const ok = (kind, name, mode, extra = {}) => K.allowedFor(kind, K.teamTool(`team.${name}`), { mode, hasTask: mode !== 'lead' && mode !== 'free', ...extra })
  check(['lead', 'dev', 'qa', 'research', 'custom'].every((k) => ['plan', 'exec', 'qa', 'lead', 'free'].every((m) => ok(k, 'show', m) && ok(k, 'tasks', m) && ok(k, 'task.get', m) && ok(k, 'comment', m) && ok(k, 'ask', m) && ok(k, 'needs', m))), 'reads, comment, ask and needs: every role, every mode')
  check(ok('lead', 'task.create', 'lead') && ok('dev', 'task.create', 'exec') && ok('custom', 'task.create', 'exec'), 'task create: the Lead, and a Dev or custom role in exec')
  check(!ok('dev', 'task.create', 'plan') && !ok('dev', 'task.create', 'exec', { hasTask: false }) && !ok('qa', 'task.create', 'qa') && !ok('research', 'task.create', 'exec') && !ok('dev', 'task.create', 'lead'), 'task create: never from a plan run, without a task, QA or research')
  check(ok('lead', 'task.update', 'lead') && !ok('dev', 'task.update', 'exec') && ok('lead', 'note', 'lead') && ok('lead', 'note', 'free') && !ok('dev', 'note', 'free'), 'task update and note: the Lead only')
  check(ok('dev', 'plan', 'plan') && ok('research', 'plan', 'plan') && ok('custom', 'plan', 'plan') && !ok('dev', 'plan', 'exec') && !ok('qa', 'plan', 'plan') && !ok('lead', 'plan', 'lead'), 'plan: dev, research and custom in plan runs')
  check(ok('dev', 'review', 'exec') && ok('custom', 'review', 'exec') && !ok('dev', 'review', 'plan') && !ok('research', 'review', 'exec'), 'review: dev and custom in exec')
  check(ok('qa', 'verdict', 'qa') && !ok('qa', 'verdict', 'exec') && !ok('dev', 'verdict', 'qa'), 'verdict: QA in qa runs')
  check(ok('research', 'done', 'plan') && ok('research', 'done', 'exec') && ok('custom', 'done', 'exec') && !ok('custom', 'done', 'plan'), 'done: research in plan or exec, custom in exec')
  check(ok('dev', 'done', 'exec', { isolation: 'main' }) && !ok('dev', 'done', 'exec', { isolation: 'worktree' }) && !ok('dev', 'done', 'exec') && !ok('qa', 'done', 'qa') && !ok('lead', 'done', 'lead'), 'done: a Dev only with isolation main')
  check(ok('lead', 'approve', 'lead') && ok('lead', 'hire', 'lead') && !ok('dev', 'approve', 'exec') && !ok('lead', 'hire', 'free'), 'approve and hire: the Lead in its runs')

  const dev = K.teamToolsGuide('dev')
  check(dev === K.teamToolsGuide('dev'), 'teamToolsGuide is deterministic')
  check(['team.plan', 'team.review', 'team.done', 'team.task.create', 'team.ask', 'snaos team plan --file <file>|- [--small]', '--parent <your task>', 'ends your run'].every((s) => dev.includes(s)), 'the Dev guide: its tools, usages and notes', dev)
  check(!['team.verdict', 'team.hire', 'team.note', 'team.task.update', 'team.approve'].some((s) => dev.includes(s)), 'the Dev guide leaves out the tools of other roles')
  check(!/--json|snaos-team|\$env:TEMP|readonly|total/.test(dev), 'the guide is channel and profile neutral (it is in sysHash)')
  const qa = K.teamToolsGuide('qa')
  check(qa.includes('team.verdict') && !qa.includes('team.plan') && !qa.includes('team.review'), 'the QA guide')
  const lead = K.teamToolsGuide('lead')
  check(['team.hire', 'team.approve', 'team.note', 'team.task.update', 'team.task.create'].every((s) => lead.includes(s)) && !lead.includes('team.plan') && !lead.includes(' runs;') && !lead.includes(' runs)'), 'the Lead guide: its tools, no run-mode notes', lead)
  check(!['lead', 'dev', 'qa', 'research', 'custom'].some((k) => DASH_RE.test(K.teamToolsGuide(k))), 'no en or em dash in any guide')

  const cli = K.teamChannelText(false, { win32: false })
  const cliWin = K.teamChannelText(false, { win32: true })
  check(cli.includes('snaos team <tool> ... --json') && !cli.includes('$env:TEMP') && !cli.includes('snaos-team'), 'CLI channel: --json calls, no Windows advice off Windows')
  check(cli === K.teamChannelText(false, { win32: false, provider: 'claude' }), 'the channel defaults to the Claude wording (the CLI guide uses it)')
  // E10 SPIKE: a Claude run calls snaos team with its Bash tool only (its allow lists carry no PowerShell rule for the CLI).
  check(cli.includes('with your Bash tool') && cli.includes('never with the PowerShell tool') && !/from your shell/.test(cli), 'Claude CLI channel: the Bash tool, never the PowerShell tool', cli)
  check(cliWin.startsWith(cli) && cliWin.includes("use a Bash heredoc (`snaos team plan --file - <<'EOF'`") && cliWin.includes('UTF-8 file outside your cwd') && cliWin.includes('--file <path>') && cliWin.includes('never pipe non-ASCII text in Windows PowerShell') && !cliWin.includes('$env:TEMP'), 'Claude CLI channel on Windows: a Bash heredoc first, or a UTF-8 file (9.1 risk 25)', cliWin)
  const cx = K.teamChannelText(false, { win32: false, provider: 'codex' })
  const cxWin = K.teamChannelText(false, { win32: true, provider: 'codex' })
  check(cx.includes('from your shell as `snaos team <tool> ... --json`') && !cx.includes('Bash tool') && cxWin.startsWith(cx) && cxWin.includes('UTF-8 file outside your cwd (for example under $env:TEMP)') && cxWin.includes('never pipe non-ASCII text in Windows PowerShell'), 'a Codex run with the CLI (danger-full-access) calls it from its own shell; the $env:TEMP file advice on Windows', cxWin)
  const block = K.teamChannelText(true, { win32: false })
  check(block === K.teamChannelText(true, { win32: true }) && block === K.teamChannelText(true, { win32: true, provider: 'codex' }), 'the block contract does not depend on the OS nor the provider')
  check(['You cannot run `snaos team` in this sandbox', '```snaos-team', 'four backticks', 'team.task.create {title', 'team.verdict', '"$1"', '64 KB', '21 actions', 'only as the last action'].every((s) => block.includes(s)), 'the block contract and its grammar (5.6)', block)
  same(K.parseTeamBlock(block), { v: 1, actions: [{ method: 'team.comment', params: { target: 't-12', text: '...' } }, { method: 'team.plan', params: { text: '...', small: true } }] }, 'the example of the contract parses as a block')
  check(![cli, cliWin, cx, cxWin, block].some((s) => DASH_RE.test(s)), 'no en or em dash in the channel texts')
}

function blockChecks() {
  const K = load('src/shared/teamTools.ts')
  const T3 = '```'
  const T4 = '````'
  const parse = (lines) => K.parseTeamBlock(Array.isArray(lines) ? lines.join('\n') : lines)
  const comment = '{"v":1,"actions":[{"method":"team.comment","params":{"target":"t-1","text":"hola"}}]}'
  same(parse(['Listo.', '', `${T3}snaos-team`, comment, T3]), { v: 1, actions: [{ method: 'team.comment', params: { target: 't-1', text: 'hola' } }] }, 'a ``` block')
  const plan = 'Pasos:\n```ts\nfoo()\n```\nFin'
  const withFences = parse(['Plan:', `${T4}snaos-team`, JSON.stringify({ v: 1, actions: [{ method: 'team.plan', params: { text: plan, small: true } }] }), T4])
  check(withFences && withFences.actions[0].params.text === plan, 'a ```` block with a plan whose text has ``` code fences inside', withFences)
  check(parse([`${T4}snaos-team`, comment, T3, T4]) === null, 'inside a ```` block a ``` line does not close it (the body is then not JSON)')
  const multi = parse([`${T3}snaos-team`, '{', '  "v": 1,', '  "actions": [', '    {"method": "team.comment", "params": {"target": "t-2", "text": "a"}},', '    {"method": "team.done", "params": {"text": "listo"}}', '  ]', '}', T3])
  check(multi && multi.actions.length === 2 && multi.actions[1].method === 'team.done', 'JSON over several lines')
  const two = parse([`${T3}snaos-team`, comment, T3, 'Mejor así:', `${T3}snaos-team`, '{"v":1,"actions":[{"method":"team.needs","params":{"text":"acceso"}}]}', T3])
  check(two && two.actions.length === 1 && two.actions[0].method === 'team.needs', 'the last complete block wins')
  const unclosed = parse([`${T3}snaos-team`, comment, T3, `${T3}snaos-team`, '{"v":1,"actions":[{"method":"team.needs","params":{"text":"x"}}]}'])
  check(unclosed && unclosed.actions[0].method === 'team.comment', 'an unclosed last block is ignored: the last complete one counts')
  check(parse([`${T3}snaos-team`, comment, T3, `${T3}snaos-team`, '{"v":1', T3]) === null, 'a broken last complete block is null (never an earlier draft)')
  check(parse(['Ejemplo:', `${T4}markdown`, `${T3}snaos-team`, comment, T3, T4]) === null, 'a block quoted inside another fence is no block')
  check(parse(['~~~', `${T3}snaos-team`, '~~~', `${T3}snaos-team`, comment, T3]).actions[0].params.text === 'hola', 'a tilde fence is tracked too; the real block after it counts')
  check(parse(`${T3}snaos-team  \r\n${comment}\r\n   ${T4}  \r\n`) !== null && parse(`   ${T3}snaos-team\n${comment}\n${T3}`) !== null && parse(`${T3} snaos-team\n${comment}\n${T3}`) !== null, 'trailing spaces, up to 3 spaces of indent, a longer closing fence, CRLF')
  check(parse(`    ${T3}snaos-team\n${comment}\n${T3}`) === null && parse(`${T3}snaos-teams\n${comment}\n${T3}`) === null && parse(`${T3}json\n${comment}\n${T3}`) === null && parse(`~~~snaos-team\n${comment}\n~~~`) === null, 'not a block: 4 spaces of indent, another info string, a tilde fence')
  check(parse(`${T3}snaos-team\n${comment}\n${T3}x\n${T3}`) === null, 'a line with an info string never closes the block')
  check(parse('') === null && parse('sin bloque') === null && K.parseTeamBlock(undefined) === null, 'no block, no text: null')

  // Refs stay as written; applyBlock resolves them (5.6).
  const refs = parse([`${T3}snaos-team`, '{"v":1,"actions":[{"method":"team.task.create","params":{"title":"A"}},{"method":"team.task.create","params":{"title":"B","blockedBy":["$1"]}},{"method":"team.comment","params":{"target":"$2","text":"c"}}]}', T3])
  check(refs && refs.actions[1].params.blockedBy[0] === '$1' && refs.actions[2].params.target === '$2', 'refs $1 and $2 survive the parse')
  check(K.TEAM_BLOCK_REF_RE.test('$1') && K.TEAM_BLOCK_REF_RE.test('$21') && K.TEAM_BLOCK_REF_RE.exec('$21')[1] === '21' && !['$0', '$100', '$1a', ' $1', '$', 't-1', '$01'].some((s) => K.TEAM_BLOCK_REF_RE.test(s)), 'TEAM_BLOCK_REF_RE')

  const wrap = (body) => parse([`${T3}snaos-team`, typeof body === 'string' ? body : JSON.stringify(body), T3])
  const act = (method, params = {}) => ({ method, params })
  check(wrap({ v: 1, actions: [act('team.review')] }) !== null && json(wrap({ v: 1, actions: [{ method: 'team.review' }] }).actions[0].params) === '{}', 'params missing reads as {}')
  check(wrap({ v: 1, actions: [act('team.show')] }) === null && wrap({ v: 1, actions: [act('team.comment', { target: 't-1', text: 'x' }), act('team.task.get', { task: 't-1' })] }) === null, 'a read method refuses the whole block')
  check(wrap({ v: 1, actions: [act('team.plan', { text: 'x' }), act('team.comment', { target: 't-1', text: 'x' })] }) === null && wrap({ v: 1, actions: [act('team.ask', { text: 'x' }), act('team.needs', { text: 'y' })] }) === null, 'a terminal only as the last action, at most one')
  check(wrap({ v: 2, actions: [act('team.review')] }) === null && wrap({ actions: [act('team.review')] }) === null && wrap({ v: 1, actions: {} }) === null && wrap({ v: 1, actions: [] }) === null && wrap('[1]') === null && wrap('no json') === null, 'v 1, an actions array, at least one action, one JSON object')
  check(wrap({ v: 1, actions: [act('team.nope')] }) === null && wrap({ v: 1, actions: [{ method: 'team.comment', params: ['x'] }] }) === null && wrap({ v: 1, actions: ['team.comment'] }) === null, 'an unknown method, array params or a bare string: null')
  const many = (n) => ({ v: 1, actions: Array.from({ length: n }, (_, i) => act('team.comment', { target: 't-1', text: `c${i}` })) })
  check(wrap(many(21)) !== null && wrap(many(22)) === null, 'at most 21 actions')
  const big = (n) => ({ v: 1, actions: [act('team.plan', { text: 'x'.repeat(n) })] })
  const overhead = JSON.stringify(big(0)).length
  check(wrap(big(64 * 1024 - overhead)) !== null && wrap(big(64 * 1024 - overhead + 1)) === null, 'at most 64 KB of body')
  check(wrap({ v: 1, actions: [act('team.plan', { text: 'ñ'.repeat(Math.floor((64 * 1024 - overhead) / 2) + 1) })] }) === null, 'the cap counts UTF-8 bytes')
}

async function main() {
  await treeChecks()
  agentCliChecks()
  argvChecks()
  toolsChecks()
  blockChecks()
  console.log(`PASS: ${checks} tree-kill checks (real grandchild tree kill, procStartTime, taskkill and kill fakes, agentCli, spawnTarget, teamArgv snapshots, grants, teamTools, guide, channel text, parseTeamBlock)`)
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
