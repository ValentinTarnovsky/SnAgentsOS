// Team runs, the process side (app 2.7.0, B2): treeKill (a real child with a real grandchild,
// `ping` (detached, out of the kill-on-close job) or `sleep`, killed with the whole tree, and the
// control that killing the child alone leaves it alive; a dead pid; the injected taskkill and kill),
// procStartTime (the test process itself and a child, injected probe outputs), childrenSince (B6
// integration, second round: the real child's direct children on Windows, never its conhost.exe, injected CIM outputs;
// B6 review: the upper bound of the window, never a child created after it, and childrenSinceSync), agentCli
// (resolveAgentCli skip rules, .exe before .cmd, spawnTarget for a .cmd), teamArgv (argv snapshots
// per provider x profile x new/resume, with the isolation flags and the protect rules on every
// Claude line, claudePathRule, grants, isGrantable, grantPatternOf: Bash rules only, never a PowerShell one, B5;
// B5 integration: never a one-word program prefix (the exact rule instead), never a shell or interpreter escape,
// isShellEscape, never a runner or launcher prefix (npx, npm exec, npm create, find, sed...: the exact rule instead), git -c
// and the denied git commands also past assignments, a folder or .exe; third round: a prefix rule only for a row of
// GRANT_PREFIX_ALLOWLIST, the exact rule for every other command, plain words only, git send-pack and http-push denied;
// fourth round: no git log, diff or show on any readonly or plan line, and no git log, diff, show, blame or branch --list
// row of the allowlist: their denial gets the exact rule; sixth round: a Read deny of every secret of the data folder,
// DATA_SECRET_PATHS, on every Claude line, which stays under cmd.exe's 8191 characters; seventh round: the guard of a
// line through cmd.exe, cmdLineTooLong past CMD_LINE_MAX for a .cmd CLI only, never for an .exe or POSIX one)
// and teamTools (the 5.3 table, allowedFor, teamToolsGuide, teamChannelText, parseTeamBlock fences and refs).
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
    if (win) {
      // B6 integration, second round: the direct children of a process, created within a window (the real CIM query).
      const kids = await T.childrenSince(a.child.pid, a.startedAt, Date.now())
      check(kids.includes(a.grand) && !kids.includes(a.child.pid), 'childrenSince: the real grandchild is a direct child of the child, created since it started', kids)
      // The hidden console host of the child (a console app spawned with pipes and no window) is never one of them.
      const hosts = require('node:child_process').execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${a.child.pid}' | Where-Object { $_.Name -eq 'conhost.exe' } | ForEach-Object { $_.ProcessId }`], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).map(Number).filter((n) => n > 0)
      check(!kids.some((k) => hosts.includes(k)), 'childrenSince: never the console host (conhost.exe) of the process', { kids, hosts })
      same(await T.childrenSince(a.child.pid, Date.now() + 60_000, Infinity), [], 'childrenSince: none created since a later time')
      // B6 review: the upper bound. Nothing the child started was created before the child itself.
      same(await T.childrenSince(a.child.pid, a.startedAt - 60_000, a.startedAt - 1), [], 'childrenSince: none created up to a time before the child started (the upper bound)')
      const sync = T.childrenSinceSync(a.child.pid, a.startedAt, Date.now())
      check(sync.includes(a.grand) && !sync.includes(a.child.pid) && !sync.some((k) => hosts.includes(k)), 'childrenSinceSync: the same real query, run synchronously (the exit hooks)', sync)
    }
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

  // childrenSince (B6 integration, second round): one CIM query of the direct children, kept within a window (B6
  // review: the upper bound is the moment the dead shell was seen to exit plus the clock slack; a process that reused
  // its pid, and whatever that one starts, is created after it and never listed).
  execs.length = 0
  const since = Date.UTC(2026, 9, 24, 13, 0, 0, 500)
  const until = Date.UTC(2026, 9, 24, 13, 0, 2, 250)
  const cim = '5001|2026-10-24T13:00:00.5000000Z\r\n5002|2026-10-24T13:00:00.4990000Z\r\n4242|2026-10-24T13:00:01Z\r\n5003|2026-10-24T13:00:02.25Z\r\n5005|2026-10-24T13:00:02.2510000Z\r\n5001|2026-10-24T13:00:03Z\r\n5006|2026-10-24T13:00:09Z\r\ngarbage\r\n0|2026-10-24T13:00:03Z\r\n5004|yesterday\r\n'
  const kids = await T.childrenSince(4242, since, until, { platform: 'win32', execFile: fakeExec(cim) })
  same(kids, [5001, 5003], 'childrenSince: created from the start to the end of the window (both included), never after it (a reused pid: 5005, 5006), never the parent itself, once each, garbled lines skipped')
  check(/^[A-Za-z]:\\.*\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i.test(execs[0].file) && json(execs[0].args.slice(0, 3)) === json(['-NoProfile', '-NonInteractive', '-Command']) && execs[0].args[3].includes("Get-CimInstance Win32_Process -Filter 'ParentProcessId=4242'") && execs[0].args[3].includes("$_.Name -ne 'conhost.exe'") && !execs[0].args[3].includes('"') && execs[0].opts.timeout === 5000 && execs[0].opts.windowsHide === true, 'childrenSince: Get-CimInstance Win32_Process by ParentProcessId through powershell.exe, never conhost.exe, hidden, 5 s, no double quote', execs[0])
  same(await T.childrenSince(4242, since, Infinity, { platform: 'win32', execFile: fakeExec(cim) }), [5001, 5003, 5005, 5006], 'childrenSince: with no upper bound every later one counts (the control of the bound)')
  same(await T.childrenSince(4242, since, until, { platform: 'win32', execFile: fakeExec('', err('ETIMEDOUT')) }), [], 'childrenSince: a failed probe finds none')
  check(T.CREATION_CLOCK_SLACK_MS >= 16 && T.CREATION_CLOCK_SLACK_MS <= 50, `the clock slack covers one Windows tick, not more (${T.CREATION_CLOCK_SLACK_MS} ms)`)
  const before = execs.length
  same([
    await T.childrenSince(4242, since, until, { platform: 'linux', execFile: fakeExec('5001|2026-10-24T13:00:01Z') }), await T.childrenSince(0, since, until, { platform: 'win32', execFile: fakeExec('5001|2026-10-24T13:00:01Z') }),
    await T.childrenSince(4242, NaN, until, { platform: 'win32', execFile: fakeExec('5001|2026-10-24T13:00:01Z') }), await T.childrenSince(4242, since, NaN, { platform: 'win32', execFile: fakeExec('5001|2026-10-24T13:00:01Z') }),
    await T.childrenSince(4242, until, since, { platform: 'win32', execFile: fakeExec('5001|2026-10-24T13:00:01Z') }),
  ], [[], [], [], [], []], 'childrenSince: nothing off Windows, for a bad pid, a bad time or an empty window')
  check(execs.length === before, 'and no probe runs for them')
  // childrenSinceSync (B6 review: killAll of the exit hooks during the drain): the same query and filter by spawnSync.
  const syncCalls = []
  const fakeSync = (status, stdout, error) => (file, args, opts) => { syncCalls.push({ file, args, opts }); return { status, stdout, error } }
  same(T.childrenSinceSync(4242, since, until, { platform: 'win32', spawnSync: fakeSync(0, cim) }), [5001, 5003], 'childrenSinceSync: the same window and filter')
  check(/powershell\.exe$/i.test(syncCalls[0].file) && syncCalls[0].args[3] === execs[0].args[3] && syncCalls[0].opts.timeout === 5000 && syncCalls[0].opts.windowsHide === true && syncCalls[0].opts.encoding === 'utf8', 'childrenSinceSync: the same script, hidden, 5 s', syncCalls[0])
  same([
    T.childrenSinceSync(4242, since, until, { platform: 'win32', spawnSync: fakeSync(1, cim) }), T.childrenSinceSync(4242, since, until, { platform: 'win32', spawnSync: fakeSync(null, '', err('ETIMEDOUT')) }),
    T.childrenSinceSync(4242, since, until, { platform: 'win32', spawnSync: () => { throw err('EPERM') } }),
  ], [[], [], []], 'childrenSinceSync: a probe that fails, times out or throws finds none')
  const nSync = syncCalls.length
  same([T.childrenSinceSync(4242, since, until, { platform: 'darwin', spawnSync: fakeSync(0, cim) }), T.childrenSinceSync(4242, until, since, { platform: 'win32', spawnSync: fakeSync(0, cim) })], [[], []], 'childrenSinceSync: nothing off Windows or for an empty window')
  check(syncCalls.length === nSync, 'and no probe runs for them')
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
    // B5 integration, seventh round: a target through cmd.exe (a .cmd CLI) whose full command line (cmd.exe, /d /s /c and
    // the quoted line) would pass CMD_LINE_MAX never spawns (RunStarter); an .exe or POSIX target is not limited.
    const cmdCli = { file: 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd', args: [], kind: 'cmd' }
    const lineOf = (argv) => { const s = A.spawnTarget(cmdCli, argv); return [s.file, ...s.args].join(' ').length }
    const fill = (n) => ['-p', 'x'.repeat(n - lineOf(['-p', '']) + 2)]
    check(A.CMD_LINE_MAX === 8000 && lineOf(fill(A.CMD_LINE_MAX)) === A.CMD_LINE_MAX && lineOf(fill(A.CMD_LINE_MAX + 1)) === A.CMD_LINE_MAX + 1, 'the full line: cmd.exe, its switches and the quoted line, counted as CreateProcess gets it', [lineOf(fill(A.CMD_LINE_MAX)), lineOf(fill(A.CMD_LINE_MAX + 1))])
    check(!A.cmdLineTooLong(cmdCli, fill(A.CMD_LINE_MAX)) && A.cmdLineTooLong(cmdCli, fill(A.CMD_LINE_MAX + 1)), 'a .cmd line of CMD_LINE_MAX characters spawns, one more does not')
    check(!A.cmdLineTooLong({ file: 'C:\\Users\\u\\.local\\bin\\claude.exe', args: [], kind: 'exe' }, fill(20000)) && !A.cmdLineTooLong({ file: '/usr/bin/claude', args: [], kind: 'posix' }, fill(20000)), 'an .exe or a POSIX target is not limited')
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
  // B5 integration, sixth round: a Read deny for every secret of the data folder (TeamService.protectPaths joins
  // DATA_SECRET_PATHS to dataDir(), a folder with its separator); the write denies stay decision 72's.
  const SECRET_FILES = ['runtime.json', 'remote-devices.json', 'push-keys.json', 'share-identity.json', 'share-grants.json', 'share-links.json', 'migration-backup-v1.zip']
  const SECRET_PATHS = [...SECRET_FILES, 'config.json', 'config.json.bak', 'backups/', 'claude-accounts/']
  same(G.DATA_SECRET_FILES, SECRET_FILES, 'DATA_SECRET_FILES: the secret files of the data folder (sixth round)')
  same(G.DATA_SECRET_PATHS, SECRET_PATHS, 'DATA_SECRET_PATHS: those plus config.json, its copies and backups, and the saved Claude logins')
  const protect = { readDeny: SECRET_PATHS.map((p) => `${DATA}\\${p.replace(/\/$/, '\\')}`), writeDeny: [`${DATA}\\teams\\`, `${DATA}\\trusted-teams.json`, `${DATA}\\runtime.json`] }
  const D = '//c/Users/u/AppData/Roaming/snagentsos'
  const both = (tools, p) => tools.flatMap((t) => [`${t}(${D}/${p})`, `${t}(${D}/${p}/**)`])
  const W = ['Edit', 'Write', 'MultiEdit']
  const READS = [
    ...both(['Read'], 'runtime.json'), ...both(['Read'], 'remote-devices.json'), ...both(['Read'], 'push-keys.json'), ...both(['Read'], 'share-identity.json'),
    ...both(['Read'], 'share-grants.json'), ...both(['Read'], 'share-links.json'), ...both(['Read'], 'migration-backup-v1.zip'), ...both(['Read'], 'config.json'),
    ...both(['Read'], 'config.json.bak'), `Read(${D}/backups/**)`, `Read(${D}/claude-accounts/**)`,
  ]
  const PROTECT = [...READS, ...W.map((t) => `${t}(${D}/teams/**)`), ...both(W, 'trusted-teams.json'), ...both(W, 'runtime.json')]
  const ISO = ['--setting-sources', 'user', '--strict-mcp-config']
  const HEAD = ['-p', '--output-format', 'stream-json', '--verbose', ...ISO]
  const TOTAL_DENY = ['Bash(git push:*)', 'Bash(git merge:*)', 'Bash(git worktree:*)', 'Bash(git update-ref:*)', 'Bash(git send-pack:*)', 'Bash(git http-push:*)',
    'PowerShell(git push:*)', 'PowerShell(git merge:*)', 'PowerShell(git worktree:*)', 'PowerShell(git update-ref:*)', 'PowerShell(git send-pack:*)', 'PowerShell(git http-push:*)']
  // B5 integration, fourth round (security): no git log, diff or show (--output writes any file, diff --no-index reads any one).
  // Fifth round: no PowerShell(git status:*) either (a $(...) subexpression could run a command inside the prefix).
  const RO_ALLOW = ['Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite', 'Bash(git status:*)']
  // Tanda B close (finding 14): a readonly or plan line denies the git fence too (the user's own permissions.allow
  // joins every Claude line through --setting-sources user, and under dontAsk only a deny wins over it).
  const RO_DENY = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', ...TOTAL_DENY]
  // E10 SPIKE (deviation of decision 2): only the Bash rule; PowerShell would run snaos.cmd, whose %* cmd.exe re-parses.
  const TEAM = ['Bash(snaos team:*)']
  same(G.CLAUDE_ISOLATION_FLAGS, ISO, 'CLAUDE_ISOLATION_FLAGS')
  same(G.CLAUDE_TOTAL_DENY, TOTAL_DENY, 'CLAUDE_TOTAL_DENY has the PowerShell twin of every Bash rule (decision 2), git push plumbing (send-pack, http-push) too')
  same(G.CLAUDE_TEAM_TOOLS, TEAM, 'CLAUDE_TEAM_TOOLS: the Bash rule only, never PowerShell(snaos team:*)')

  const claude = (profile, session, extra = {}) => G.teamArgv({ provider: 'claude', profile, session, systemFile: sys, cwd, protect, ...extra })
  const grants = ['Bash(npm test:*)', 'PowerShell(npm test:*)', 'Bash(git push:*)', 'Task', 'mcp__github__create_issue', 'Bash(npm test:*)']
  const snaps = {
    'claude total new': [claude('total', { kind: 'new', sessionId: SID }, { model: 'sonnet', effort: 'medium', grants }),
      [...HEAD, '--session-id', SID, '--model', 'sonnet', '--effort', 'medium', '--append-system-prompt-file', sys, '--permission-mode', 'bypassPermissions', '--disallowedTools', ...TOTAL_DENY, ...PROTECT]],
    'claude total resume': [claude('total', { kind: 'resume', sessionId: SID }),
      [...HEAD, '--resume', SID, '--append-system-prompt-file', sys, '--permission-mode', 'bypassPermissions', '--disallowedTools', ...TOTAL_DENY, ...PROTECT]],
    'claude readonly new': [claude('readonly', { kind: 'new', sessionId: SID }, { model: 'opus', effort: 'high', grants }),
      [...HEAD, '--session-id', SID, '--model', 'opus', '--effort', 'high', '--append-system-prompt-file', sys, '--permission-mode', 'dontAsk', '--allowedTools', ...RO_ALLOW, ...TEAM, 'Bash(npm test:*)', '--disallowedTools', ...RO_DENY, ...PROTECT]],
    'claude readonly resume': [claude('readonly', { kind: 'resume', sessionId: SID }, { model: 'haiku' }),
      [...HEAD, '--resume', SID, '--model', 'haiku', '--append-system-prompt-file', sys, '--permission-mode', 'dontAsk', '--allowedTools', ...RO_ALLOW, ...TEAM, '--disallowedTools', ...RO_DENY, ...PROTECT]],
    'claude custom new': [claude('custom', { kind: 'new', sessionId: SID }, { allowedTools: ['Read', 'Edit', 'Bash(npm test:*)', 'Read', 'bad tool'], grants: ['Bash(npm run:*)', 'Bash(snaos team:*)', 'Agent'] }),
      [...HEAD, '--session-id', SID, '--append-system-prompt-file', sys, '--permission-mode', 'dontAsk', '--allowedTools', 'Read', 'Edit', 'Bash(npm test:*)', ...TEAM, 'Bash(npm run:*)', '--disallowedTools', ...TOTAL_DENY, ...PROTECT]],
    'claude custom resume': [claude('custom', { kind: 'resume', sessionId: SID }, { allowedTools: ['Grep'] }),
      [...HEAD, '--resume', SID, '--append-system-prompt-file', sys, '--permission-mode', 'dontAsk', '--allowedTools', 'Grep', ...TEAM, '--disallowedTools', ...TOTAL_DENY, ...PROTECT]],
  }
  // A role or a grant that names the CLI through PowerShell never reaches the allow list (snaos.cmd, cmd.exe).
  const psCli = ['PowerShell(snaos team:*)', 'PowerShell(snaos:*)', 'PowerShell(SNAOS.CMD team:*)', 'PowerShell(& snaos team:*)', 'PowerShell(C:/Users/u/bin/snaos.cmd team:*)', 'PowerShell(sna:*)']
  // A role's own Bash rule for the CLI goes too: Git Bash hands snaos.cmd to cmd.exe as well, and Bash(snaos team:*) is always there.
  snaps['claude custom with PowerShell CLI rules'] = [claude('custom', { kind: 'new', sessionId: SID }, { allowedTools: ['Read', ...psCli, 'Bash(snaos:*)', 'Bash(snaos.cmd team:*)', 'Bash(npm test:*)'], grants: ['PowerShell(snaos team:*)', 'PowerShell(npm test:*)'] }),
    [...HEAD, '--session-id', SID, '--append-system-prompt-file', sys, '--permission-mode', 'dontAsk', '--allowedTools', 'Read', 'Bash(npm test:*)', ...TEAM, '--disallowedTools', ...TOTAL_DENY, ...PROTECT]]
  snaps['claude readonly with a PowerShell CLI grant'] = [claude('readonly', { kind: 'new', sessionId: SID }, { grants: [...psCli, 'Bash(snaos team:*)'] }),
    [...HEAD, '--session-id', SID, '--append-system-prompt-file', sys, '--permission-mode', 'dontAsk', '--allowedTools', ...RO_ALLOW, ...TEAM, '--disallowedTools', ...RO_DENY, ...PROTECT]]
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
  const GIT_READS_RE = /^(?:Bash|PowerShell)\(git (?:log|diff|show|blame|branch)\b/i
  for (const permission of ['total', 'custom', 'readonly']) {
    const plan = claude(G.effectiveProfile(permission, 'plan'), { kind: 'new', sessionId: SID })
    check(allowOf(plan.argv).includes('Bash(snaos team:*)') && !plan.argv.some((a) => /^PowerShell\(snaos/i.test(a)), `a plan run of a ${permission} role: Bash(snaos team:*) only`)
    check(!allowOf(plan.argv).some((a) => GIT_READS_RE.test(a)) && allowOf(plan.argv).includes('Bash(git status:*)'), `a plan run of a ${permission} role: no git log, diff or show (fourth round); git status stays`, allowOf(plan.argv))
    const deny = plan.argv.slice(plan.argv.indexOf('--disallowedTools') + 1)
    check(TOTAL_DENY.every((d) => deny.includes(d)), `a plan run of a ${permission} role keeps the git fence of CLAUDE_TOTAL_DENY (Tanda B close)`, deny)
  }
  // Fourth round: no readonly line carries git log, diff or show, also when a stored grant of an older build names one.
  for (const [label, [res]] of Object.entries(snaps)) if (label.includes('readonly')) check(!allowOf(res.argv).some((a) => GIT_READS_RE.test(a)), `${label}: no git log, diff or show on the line`, allowOf(res.argv))
  // Fifth round: no readonly or plan line allows any PowerShell rule (git status is Bash only); the deny lists keep their twins.
  for (const [label, [res]] of Object.entries(snaps)) if (label.includes('readonly')) check(!allowOf(res.argv).some((a) => /^PowerShell\(/i.test(a)), `${label}: no PowerShell rule on the allow list (fifth round)`, allowOf(res.argv))
  for (const permission of ['total', 'custom', 'readonly']) check(!allowOf(claude(G.effectiveProfile(permission, 'plan'), { kind: 'new', sessionId: SID }).argv).some((a) => /^PowerShell\(/i.test(a)), `a plan run of a ${permission} role: no PowerShell rule on the allow list (fifth round)`)
  check(!G.CLAUDE_READONLY_ALLOW.some((a) => /^PowerShell\(/i.test(a)) && G.CLAUDE_TOTAL_DENY.filter((a) => /^PowerShell\(/.test(a)).length === 6, 'CLAUDE_READONLY_ALLOW has no PowerShell rule; CLAUDE_TOTAL_DENY keeps the 6 PowerShell twins')
  const oldGrants = claude('readonly', { kind: 'new', sessionId: SID }, { grants: ['Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)', 'Bash(git blame:*)', 'Bash(git branch --list:*)', 'PowerShell(git log:*)', 'Bash(git status:*)'] })
  same(allowOf(oldGrants.argv), [...RO_ALLOW, ...TEAM], 'a readonly line drops the git log, diff, show, blame and branch --list prefix grants an earlier build stored')
  same(G.CLAUDE_READONLY_ALLOW, RO_ALLOW, 'CLAUDE_READONLY_ALLOW: the read tools and git status only')
  const noProtect = G.teamArgv({ provider: 'claude', profile: 'total', session: { kind: 'new', sessionId: SID }, cwd })
  check(!noProtect.argv.some((a) => a.includes('//')) && !noProtect.argv.includes('--append-system-prompt-file'), 'without protect nor systemFile: no path rule and no system flag')
  // Sixth round: the Read denies of every secret keep a Claude line through cmd.exe (a `.cmd` CLI, spawnTarget) under
  // its 8191 characters, with a long portable data folder, a custom role of ten tools and GRANTS_MAX long grants
  // (an Edit, Write and MultiEdit deny per secret would not fit: they stay decision 72's three paths).
  const electron = { app: { isPackaged: false, getPath: () => os.tmpdir(), getVersion: () => '2.7.0', commandLine: { hasSwitch: () => false }, on() {} } }
  const A = load('src/main/teams/agentCli.ts', { require: (id) => (id === 'electron' ? electron : require(id)), process: { ...process, env: {}, argv: ['electron'] } })
  const LONG = 'D:\\Programas\\Portables\\Herramientas de desarrollo\\SnAgentsOS 2.7.0\\snagentsos-data'
  const longProtect = { readDeny: SECRET_PATHS.map((p) => path.win32.join(LONG, p)), writeDeny: [path.win32.join(LONG, 'teams'), path.win32.join(LONG, 'trusted-teams.json'), path.win32.join(LONG, 'runtime.json')] }
  const longGrants = Array.from({ length: 32 }, (_, i) => `Bash(npx tsc --noEmit -p packages/module-${i}/tsconfig.json)`)
  const roleTools = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash(npm test:*)', 'Bash(npm run lint:*)', 'Bash(cargo test:*)', 'WebFetch', 'WebSearch']
  for (const profile of ['total', 'readonly', 'custom']) {
    const res = G.teamArgv({ provider: 'claude', profile, session: { kind: 'new', sessionId: SID }, model: 'opus', effort: 'high', systemFile: path.win32.join(LONG, 'teams', 'tm-0123456789ab', 'runs', 'r-0123456789ab.system.md'), cwd, protect: longProtect, allowedTools: roleTools, grants: longGrants })
    const line = A.spawnTarget({ file: 'C:\\Users\\usuario\\AppData\\Roaming\\npm\\claude.cmd', args: [], kind: 'cmd' }, res.argv).args[3]
    check(line.length < 8191 && res.argv.includes(`Read(//d/Programas/Portables/Herramientas de desarrollo/SnAgentsOS 2.7.0/snagentsos-data/claude-accounts/**)`), `a ${profile} line with every protect rule through cmd.exe stays under 8191 characters (${line.length})`)
    check(!A.cmdLineTooLong({ file: 'C:\\Users\\usuario\\AppData\\Roaming\\npm\\claude.cmd', args: [], kind: 'cmd' }, res.argv), `the guard lets that ${profile} line spawn through cmd.exe (seventh round)`)
  }
  // Seventh round: a custom role of GRANTS_MAX long tools (120 characters each inside its parentheses) passes the limit
  // through cmd.exe: the guard refuses it there (RunStarter ends the run spawnFailed with its own card), never as an .exe.
  const longTools = Array.from({ length: 32 }, (_, i) => `Bash(npx tsc --noEmit -p packages/module-${String(i).padStart(2, '0')}/${'sub/'.repeat(15)}tsconfig.build.json)`)
  check(longTools.every((t) => /^Bash\([^()"'`\r\n]{110,120}\)$/.test(t)), 'the long tools are tool patterns of up to 120 characters inside their parentheses', longTools[0].length)
  const heavy = G.teamArgv({ provider: 'claude', profile: 'custom', session: { kind: 'new', sessionId: SID }, systemFile: path.win32.join(LONG, 'teams', 'tm-0123456789ab', 'runs', 'r-0123456789ab.system.md'), cwd, protect: longProtect, allowedTools: longTools, grants: longGrants })
  check(longTools.every((t) => heavy.argv.includes(t)), 'every long tool reaches the line')
  check(A.cmdLineTooLong({ file: 'C:\\Users\\usuario\\AppData\\Roaming\\npm\\claude.cmd', args: [], kind: 'cmd' }, heavy.argv), 'through a .cmd CLI that line passes CMD_LINE_MAX: refused')
  check(!A.cmdLineTooLong({ file: 'C:\\Users\\usuario\\.local\\bin\\claude.exe', args: [], kind: 'exe' }, heavy.argv), 'the same line through an .exe CLI is not limited')
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

  const grantable = ['Read', 'Edit', 'WebFetch', 'Bash(npm test:*)', 'Bash(git status:*)', 'Bash(Get-ChildItem src)', 'Bash(git pushx)', 'Bash(npm run build)', 'Bash(make)', 'Bash(CI=1 make)', 'Bash(CI=1 npm test:*)']
  const refused = ['Bash(git push:*)', 'PowerShell(git push --force:*)', 'Bash(git push)', 'Bash(git:*)', 'Bash(gi:*)', 'Bash(:*)', 'Bash(*)', 'Bash(npm *)', 'Bash', 'PowerShell', 'Bash(git  merge:*)', 'PowerShell(GIT UPDATE-REF:*)', 'Bash(git -C:*)', 'PowerShell(git -c x=y:*)', 'Bash(git --git-dir=x status)', 'mcp__x', 'mcp__github__create_issue', 'Task', 'Agent', 'Task(explore)', 'bad tool', 'Bash(echo "x")', '']
  check(grantable.every(G.isGrantable), 'isGrantable: plain tools and shell prefixes', grantable.filter((t) => !G.isGrantable(t)))
  check(!refused.some(G.isGrantable), 'isGrantable refuses git push / merge / worktree / update-ref, a bare or wildcard shell, mcp__x, Task and Agent', refused.filter(G.isGrantable))
  // B5 (E10 SPIKE): never a PowerShell rule, whatever it names: npm.cmd, npx.cmd and the like re-parse %* in cmd.exe.
  const psRules = ['PowerShell(npm test:*)', 'PowerShell(Get-ChildItem:*)', 'PowerShell(snap list:*)', 'PowerShell(./build.cmd:*)', 'PowerShell(. ./env.ps1:*)', 'powershell(ls:*)']
  check(!psRules.some(G.isGrantable), 'isGrantable refuses every PowerShell rule (a grant is a Bash rule only)', psRules.filter(G.isGrantable))
  const cliRules = [...psCli, 'Bash(snaos team:*)', 'Bash(snaos:*)', 'Bash(snaos ls)', 'PowerShell(& $env:SNAOS_CLI team:*)',
    'PowerShell(&snaos team:*)', 'PowerShell(. snaos team:*)', 'PowerShell(snaos.c:*)', 'PowerShell(SNAOS.CM:*)', 'PowerShell(C:/Users/u/bin/sn:*)', 'PowerShell(C:/Users/u/bin/:*)', 'PowerShell(.:*)']
  check(!cliRules.some(G.isGrantable) && G.isGrantable('Bash(snap list)') && G.isGrantable('Bash(snake run)') && G.isGrantable('Bash(./build.sh all)') && G.isGrantable('Bash(. ./env.sh)'), 'isGrantable never grants a shell rule that names the CLI (Bash(snaos team:*) is always there; PowerShell would reach snaos.cmd); look-alike names keep their exact rule', cliRules.filter(G.isGrantable))
  same(G.grantPatternOf({ tool: 'PowerShell', input: { command: 'snaos team comment t-1 x&calc' } }), [], 'a PowerShell denial of snaos team grants nothing (never PowerShell(snaos team:*))')
  same(G.grantPatternOf({ tool: 'PowerShell', input: { command: 'snaos.cmd team show --json' } }), [], 'nor through the .cmd name')
  same(G.grantPatternOf({ tool: 'PowerShell', input: { command: '. snaos team comment t-1 x&calc' } }), [], 'nor through the dot-source operator (`. snaos`, both words plain)')
  same(G.grantPatternOf({ tool: 'PowerShell', input: { command: 'snaos.c' } }), ['Bash(snaos.c)'], 'a one-word command: its exact rule, which never grows into snaos.cmd')
  // B5 integration item 1: a grant never ends in a one-word prefix (`make:*` would match `make.cmd 'x&calc'` by text).
  const oneWord = ['Bash(make:*)', 'Bash(CI=1 make:*)', 'Bash(FOO=1:*)', 'Bash(FOO=1 BAR=2:*)', 'Bash(./build.sh:*)', 'Bash(snake:*)', 'Bash(Get-ChildItem:*)', 'Bash(npm.cmdx:*)']
  check(!oneWord.some(G.isGrantable) && G.isGrantable('Bash(make)') && G.isGrantable('Bash(npm test:*)') && G.isGrantable('Bash(make all:*)'), 'isGrantable refuses a one-word program prefix; the exact rule and a multi-word prefix stay', oneWord.filter(G.isGrantable))
  same(G.grantPatternOf({ tool: 'Bash', input: { command: 'make' } }), ['Bash(make)'], 'a one-word command: the exact rule, no :*')
  same(G.grantPatternOf({ tool: 'Bash', input: { command: '  make  ' } }), ['Bash(make)'], 'trimmed')
  same(G.grantPatternOf({ tool: 'Bash', input: { command: 'CI=1 make' } }), ['Bash(CI=1 make)'], 'its assignments kept in the exact rule')
  same(G.grantPatternOf({ tool: 'Bash', input: { command: 'CI=1 npm test -- -w' } }), ['Bash(CI=1 npm test:*)'], 'a multi-word program: the prefix up to its first argument, past the assignments')
  same(G.grantPatternOf({ tool: 'Bash', input: { command: 'make "all"' } }), [], 'a one-word program with a quoted argument: nothing (no exact rule of plain words, never make:*)')
  same(G.grantPatternOf({ tool: 'Bash', input: { command: 'make\nrm -rf x' } }), [], 'nor one followed by more lines')
  same(G.grantPatternOf({ tool: 'Bash', input: { command: 'FOO=1 BAR=2' } }), [], 'assignments alone: nothing')
  // B5 integration, second round (security): a runner or launcher gets only its exact command rule, never a prefix
  // (`find .:*` grows into `-exec`, `npm exec:*` runs any package). Third round: none of them is a row of the allowlist.
  const launchers = ['Bash(bunx vite:*)', 'Bash(pnpx create-vite:*)', 'Bash(uvx ruff:*)', 'Bash(pipx run:*)', 'Bash(pnpm dlx create-vite:*)', 'Bash(pnpm exec:*)',
    'Bash(yarn dlx:*)', 'Bash(yarn exec:*)', 'Bash(npm exec:*)', 'Bash(npm x:*)', 'Bash(npm exec foo:*)', 'Bash(winpty node:*)', 'Bash(wmic process:*)', 'Bash(rundll32 x.dll:*)',
    'Bash(mshta x.hta:*)', 'Bash(cscript x.vbs:*)', 'Bash(wscript x.js:*)', 'Bash(forfiles /p:*)', 'Bash(regsvr32 /s:*)', 'Bash(msiexec /i:*)', 'Bash(schtasks /create:*)',
    'Bash(runas /user:x:*)', 'Bash(at now:*)', 'Bash(sed -n:*)', 'Bash(gsed -i:*)', 'Bash(awk -F:*)', 'Bash(gawk -f:*)', 'Bash(mawk x:*)', 'Bash(nawk x:*)', 'Bash(perl x.pl:*)',
    'Bash(perl5.36 x.pl:*)', 'Bash(find .:*)', 'Bash(find src -name:*)', 'Bash(/usr/bin/find .:*)', 'Bash(npx cowsay:*)', 'Bash(CI=1 npx tsx:*)', 'Bash(git -c core.pager=x:*)',
    'Bash(npm --prefix:*)', 'Bash(npm -w web:*)', 'Bash(npm ex:*)', 'Bash(pnpm d:*)', 'Bash(NPM EXEC:*)', 'Bash(npm explore:*)', 'Bash(pnpm recursive:*)', 'Bash(yarn workspace:*)',
    'Bash(bun x:*)', 'Bash(uv tool:*)']
  check(!launchers.some(G.isGrantable), 'isGrantable refuses a runner or launcher prefix: its program, or its program and first argument (also behind an option or as a partial word)', launchers.filter(G.isGrantable))
  const launcherExact = ['Bash(npx tsc --noEmit)', 'Bash(npm exec foo)', 'Bash(pnpm dlx create-vite)', 'Bash(find . -name x)', 'Bash(sed -n 1p a.txt)', 'Bash(perl x.pl)', 'Bash(wmic os get caption)']
  check(launcherExact.every(G.isGrantable), 'their exact command rule stays grantable (the user approves the full command)', launcherExact.filter((t) => !G.isGrantable(t)))
  const keptPrefixes = ['Bash(npm test:*)', 'Bash(npm run:*)', 'Bash(pnpm run:*)', 'Bash(yarn test:*)', 'Bash(bun test:*)', 'Bash(npx tsc:*)', 'Bash(C:/tools/npx.exe tsc:*)', 'Bash(CI=1 npx vitest:*)']
  check(keptPrefixes.every(G.isGrantable), 'npm test, npm run and the npx rows of the allowlist keep their prefix rules (past assignments, a folder or .exe)', keptPrefixes.filter((t) => !G.isGrantable(t)))
  const lostPrefixes = ['Bash(npm start:*)', 'Bash(go env:*)', 'Bash(npm t:*)', 'Bash(uv sync:*)', 'Bash(bun run:*)', 'Bash(npm install:*)', 'Bash(ls src:*)', 'Bash(Get-ChildItem src:*)', 'Bash(git pushx:*)']
  check(!lostPrefixes.some(G.isGrantable), 'npm start, go env, npm install and the other prefixes off the allowlist are refused (third round)', lostPrefixes.filter(G.isGrantable))
  check(!G.isGrantable('Bash(runas /user:admin make)') && !G.isGrantable('Bash(git -c x=y log)') && !G.isGrantable('Bash(perl -e 1)'), 'an escape of decision 2 (runas, perl -e) and git -c stay never grantable, exact rule or not')
  const grantOf = (command, tool = 'Bash') => G.grantPatternOf({ tool, input: { command } })
  // B5 integration, third round (security): a `:*` prefix rule only for a row of GRANT_PREFIX_ALLOWLIST (a denylist of
  // launchers can never be complete); every other grantable denial gets the exact rule, the full command.
  same(G.GRANT_PREFIX_ALLOWLIST, [['npm', 'test'], ['npm', 'run'], ['pnpm', 'test'], ['pnpm', 'run'], ['yarn', 'test'], ['yarn', 'run'], ['bun', 'test'],
    ['cargo', 'test'], ['cargo', 'build'], ['cargo', 'check'], ['cargo', 'clippy'], ['cargo', 'fmt'], ['go', 'test'], ['go', 'build'], ['go', 'vet'], ['dotnet', 'test'], ['dotnet', 'build'],
    ['mvn', 'test'], ['mvn', 'verify'], ['gradle', 'test'], ['gradle', 'build'], ['gradlew', 'test'], ['gradlew', 'build'], ['python', '-m', 'pytest'], ['python3', '-m', 'pytest'], ['py', '-m', 'pytest'],
    ['pytest', '<target>'], ['make', '<target>'], ['npx', 'tsc'], ['npx', 'eslint'], ['npx', 'prettier'], ['npx', 'vitest'], ['npx', 'jest'], ['node', '<script>'], ['python', '<script>'],
    ['git', 'status'], ['git', 'ls-files'], ['git', 'rev-parse']], 'GRANT_PREFIX_ALLOWLIST: the test, build, lint and git read commands (no git grep: -O<pager> runs a command; fourth round: no git log, diff, show, blame or branch --list)')
  const sample = { '<target>': 'all', '<script>': 'scripts/build.js' }
  const rowCmds = Array.from(G.GRANT_PREFIX_ALLOWLIST, (row) => row.map((w) => sample[w] ?? w).join(' '))
  same(rowCmds.map((c) => grantOf(`${c} --extra x`)), rowCmds.map((c) => [`Bash(${c}:*)`]), 'every row of the allowlist yields its prefix rule, the row\'s words (at least two), never the words after it')
  same(rowCmds.map((c) => grantOf(c)), rowCmds.map((c) => [`Bash(${c}:*)`]), 'also with nothing after the row')
  const rows = [['npm test -- -w', 'Bash(npm test:*)'], ['CI=1 npm test', 'Bash(CI=1 npm test:*)'], ['./gradlew test --info', 'Bash(./gradlew test:*)'], ['C:/x/gradlew build', 'Bash(C:/x/gradlew build:*)'],
    ['python -m pytest -q', 'Bash(python -m pytest:*)'], ['py -m pytest tests', 'Bash(py -m pytest:*)'], ['pytest tests/x.py -q', 'Bash(pytest tests/x.py:*)'], ['pytest tests/x.py::test_a', 'Bash(pytest tests/x.py::test_a:*)'],
    ['make all -j4', 'Bash(make all:*)'], ['npx tsc --noEmit', 'Bash(npx tsc:*)'], ['CI=1 npx vitest run', 'Bash(CI=1 npx vitest:*)'], ['node scripts/build.js --prod', 'Bash(node scripts/build.js:*)'],
    ['node ./x.cjs', 'Bash(node ./x.cjs:*)'], ['node.exe a.mjs', 'Bash(node.exe a.mjs:*)'], ['node src/x.ts', 'Bash(node src/x.ts:*)'], ['python tools/gen.py --out x', 'Bash(python tools/gen.py:*)'],
    ['git.exe status --short', 'Bash(git.exe status:*)'], ['/usr/bin/git ls-files -z', 'Bash(/usr/bin/git ls-files:*)'], ['GIT rev-parse HEAD', 'Bash(GIT rev-parse:*)'],
    ['git status --short | head', 'Bash(git status:*)'], ['npm test -- -w\nnpm run lint', 'Bash(npm test:*)']]
  same(rows.map(([c]) => grantOf(c)), rows.map(([, r]) => [r]), 'a row matches past assignments, with the program\'s folder and .exe dropped and in any case, on the first line only')
  const exact = ['go run .', 'deno run main.ts', 'uv run pytest', 'poetry run pytest', 'bundle exec rake', 'corepack pnpm install', 'cross-env CI=1 npm test', 'dotenv -- npm test', 'watch make',
    'script -c make', 'npm install lodash', 'pip install requests', 'git config core.pager x', 'git submodule foreach make', 'git bisect run make', 'git rebase -x make main',
    'git filter-branch --tree-filter make', 'npx cowsay hi', 'npx tsc-watch --once', 'frobnicate --all', 'git grep -n foo', 'git grep -Ocalc x', 'git branch -D x', 'npm start', 'go env GOPATH', 'npm t',
    'bun run dev', 'npm TEST', 'python3 setup.py test', 'node --inspect app.js', 'node ../x.js', 'node /tmp/x.js', 'node C:/x.js', 'node x.txt', 'make -j4', 'make CC=gcc', 'make ../x', 'pytest -q', 'pytest ~/x.py',
    // Fourth round (security): the git reads that write or read any file through an option are off the allowlist.
    'git log --oneline', 'git diff --stat', 'git show HEAD', 'git blame src/a.ts', 'git branch --list', 'git branch --list --no-list -D main', 'git log -1 --format=x --output=scripts/test.js', 'git diff --no-index /dev/null x']
  same(exact.map((c) => grantOf(c)), exact.map((c) => [`Bash(${c})`]), 'go run, deno run, uv run, poetry run, bundle exec, corepack pnpm, cross-env, dotenv, watch, script -c, npm install, pip install, git config, submodule foreach, bisect run, rebase -x, filter-branch, git grep, npx <other>, an unknown tool, and since the fourth round git log, diff, show, blame and branch --list: their exact rule')
  same([grantOf('npx  cowsay   hi'), grantOf('  npm start  ')], [['Bash(npx  cowsay   hi)'], ['Bash(npm start)']], 'the exact rule keeps the spacing the run wrote (trimmed)')
  const outside = ['Bash(go run:*)', 'Bash(git grep:*)', 'Bash(git branch:*)', 'Bash(git commit:*)', 'Bash(make -j4:*)', 'Bash(make CC=x:*)', 'Bash(make ~/x:*)', 'Bash(make C:x:*)', 'Bash(node ../x.js:*)',
    'Bash(node /tmp/x.js:*)', 'Bash(node x.txt:*)', 'Bash(python3 x.py:*)', 'Bash(npm test --watch:*)', 'Bash(git:*)', 'Bash(npx:*)', 'Bash(cross-env npm:*)', 'Bash(script -c:*)', 'Bash(pytest -q:*)',
    'Bash(npm TEST:*)', 'Bash(python -m pip:*)', 'Bash(git branch --list -D:*)',
    'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)', 'Bash(git blame:*)', 'Bash(git branch --list:*)', 'Bash(CI=1 git log:*)', 'Bash(/usr/bin/git diff:*)', 'Bash(git.exe show:*)']
  check(!outside.some(G.isGrantable), 'isGrantable refuses a prefix rule that is not exactly a row of the allowlist (stored state of an older version too)', outside.filter(G.isGrantable))
  const stored = claude('readonly', { kind: 'new', sessionId: SID }, { grants: ['Bash(npm test:*)', 'Bash(npm install:*)', 'Bash(ls src:*)', 'Bash(go run .)', 'Bash(git grep:*)'] })
  same(allowOf(stored.argv).slice(-2), ['Bash(npm test:*)', 'Bash(go run .)'], 'teamArgv drops a stored prefix grant off the allowlist; the row and the exact rule reach --allowedTools')
  // Item 2: every word of a Bash rule is a plain word; git send-pack and git http-push are denied like git push.
  const notPlain = ['Bash(npm test $X:*)', 'Bash(npm run a\\b:*)', 'Bash(make a>b)', 'Bash(cat <x)', 'Bash(ls ?)', 'Bash(ls [ab])', 'Bash(echo a|b)', 'Bash(a;b)', 'Bash(npm test &:*)', 'Bash(echo $HOME)',
    'Bash(go run {a,b})', 'Bash(ls !x)', 'Bash(echo #x)', 'Bash(make a&&b)', 'Bash(x=$(y) make)', 'Bash( )']
  check(!notPlain.some(G.isGrantable), 'isGrantable refuses a rule with a word that is not plain (backslash, $, glob, redirection, operator, brace or comment)', notPlain.filter(G.isGrantable))
  same(['echo $HOME', 'make a>b', 'cat x 2>&1'].map((c) => grantOf(c)), [[], [], []], 'so such a denial grants no exact rule')
  // Verifier of the third round: no `%` either. With the Claude CLI as claude.cmd, cmd.exe expands `%VAR%` in argv
  // (also inside quotes), so the rule the run gets would not be the one the user approved.
  const percent = ['Bash(rm -rf %SystemDrive%/)', 'Bash(make %HOMEDRIVE%:*)', 'Bash(node %APPDATA%/x.js:*)', 'Bash(date +%s)', 'Bash(pytest %x%:*)']
  check(!percent.some(G.isGrantable), 'isGrantable refuses a Bash rule with a % (cmd.exe expands %VAR% when the CLI is a .cmd)', percent.filter(G.isGrantable))
  same(['rm -rf %SystemDrive%/', 'make %HOMEDRIVE%', 'node %APPDATA%/x.js', 'date +%s', 'git log --format=%h -1', 'npm test -- --grep=%x'].map((c) => grantOf(c)), [[], [], [], [], [], ['Bash(npm test:*)']],
    'so such a denial grants nothing (git log, off the allowlist since the fourth round, too), but a row before the % keeps its prefix (npm test -- --grep=%x)')
  const pushPlumbing = ['Bash(git send-pack origin main)', 'Bash(git http-push x)', 'Bash(CI=1 git.exe send-pack x)', 'Bash(/usr/bin/git http-push:*)', 'Bash(git send-pack)', 'Bash(git send-pac:*)']
  check(!pushPlumbing.some(G.isGrantable), 'isGrantable refuses git send-pack and git http-push (git push plumbing), past assignments, a folder or .exe', pushPlumbing.filter(G.isGrantable))
  same(['git send-pack origin main', 'git http-push https://x/ main', 'CI=1 git.exe send-pack x'].map((c) => grantOf(c)), [[], [], []], 'and their denial grants nothing')
  // Verifier of the second round: git -c and the denied git commands also behind assignments or as git.exe or a path
  // (coversDenied reads the program as git runs it), and npm init / create (npm exec create-<x>) and the other create.
  const gitForms = ['Bash(CI=1 git -c:*)', 'Bash(CI=1 git -c core.pager=x log:*)', 'Bash(git.exe -c:*)', 'Bash(GIT.EXE -C x:*)', 'Bash(/usr/bin/git -c x=y log)', 'Bash(C:/Git/cmd/git.exe -C x log:*)',
    'Bash(CI=1 git push:*)', 'Bash(A=1 B=2 git push origin)', 'Bash(git.exe push:*)', 'Bash(/usr/bin/git merge x)', 'Bash(CI=1 git pu:*)', 'Bash(git.exe worktree add:*)', 'Bash(CI=1 C:/x/git.exe update-ref:*)']
  check(!gitForms.some(G.isGrantable) && G.isGrantable('Bash(CI=1 git status:*)') && G.isGrantable('Bash(git.exe status:*)') && G.isGrantable('Bash(/usr/bin/git rev-parse:*)'), 'git -c and git push, merge, worktree and update-ref stay refused past assignments, a folder or .exe; other git keeps its prefix', gitForms.filter(G.isGrantable))
  same(['CI=1 git -c core.pager=calc log', 'git.exe -c alias.x=!calc x', 'CI=1 git push origin main', 'git.exe push origin', '/usr/bin/git -C /repo push'].map((c) => grantOf(c)), [[], [], [], [], []], 'so such a denial grants nothing')
  const createRules = ['Bash(npm init:*)', 'Bash(npm create:*)', 'Bash(npm innit:*)', 'Bash(npm init vite:*)', 'Bash(npm i:*)', 'Bash(npm cr:*)', 'Bash(pnpm create:*)', 'Bash(yarn create:*)', 'Bash(bun create:*)', 'Bash(bun c:*)']
  check(!createRules.some(G.isGrantable) && ['Bash(npm install)', 'Bash(npm ci)', 'Bash(pnpm install)', 'Bash(yarn cache clean)', 'Bash(npm init -y)'].every(G.isGrantable), 'npm init, create and innit and pnpm, yarn and bun create are launchers (also as a partial word: npm i:*); npm install and ci get their exact rule', createRules.filter(G.isGrantable))
  same(['npm create vite@latest app', 'npm init vite', 'yarn create vite', 'npm i lodash', 'npm install lodash'].map((c) => grantOf(c)), [['Bash(npm create vite@latest app)'], ['Bash(npm init vite)'], ['Bash(yarn create vite)'], ['Bash(npm i lodash)'], ['Bash(npm install lodash)']], 'their denial grants the exact command rule')
  same(['npx tsx run.ts', 'CI=1 npx cowsay hi', 'npm exec -- vitest', 'pnpm dlx create-vite app', 'yarn dlx x', 'npm x cowsay', 'sed -i s/a/b/ x.txt', 'find . -name x', 'npm --prefix web exec x', 'npm explore foo -- ls', 'bun x vite', 'uv tool run ruff'].map((c) => grantOf(c)),
    [['Bash(npx tsx run.ts)'], ['Bash(CI=1 npx cowsay hi)'], ['Bash(npm exec -- vitest)'], ['Bash(pnpm dlx create-vite app)'], ['Bash(yarn dlx x)'], ['Bash(npm x cowsay)'], ['Bash(sed -i s/a/b/ x.txt)'], ['Bash(find . -name x)'], ['Bash(npm --prefix web exec x)'], ['Bash(npm explore foo -- ls)'], ['Bash(bun x vite)'], ['Bash(uv tool run ruff)']],
    'grantPatternOf: a launcher denial grants its exact command rule, the full command')
  same([grantOf('npx cowsay', 'PowerShell'), grantOf('find . -name "*.ts"'), grantOf('find . -exec rm {} +'), grantOf('npx cowsay\nnpx eslint .'), grantOf('npx cowsay | tee x')], [['Bash(npx cowsay)'], [], [], [], []], 'through PowerShell too; with a quote, an operator or more lines: nothing (no exact rule of plain words, never a prefix)')
  same(['npm start', 'npm test -- -w', 'go env GOPATH', 'npm run build'].map((c) => grantOf(c)), [['Bash(npm start)'], ['Bash(npm test:*)'], ['Bash(go env GOPATH)'], ['Bash(npm run:*)']], 'npm test and npm run build keep their prefix rules; npm start and go env, off the allowlist, get their exact rule')
  // B5 integration item 2: shell and interpreter escapes are never grantable, by rule or by denial.
  const escapes = ['bash -c x', 'sh -c "x"', 'zsh -c x', 'dash -c x', 'cmd /c dir', 'cmd.exe /c dir', 'powershell -Command x', 'pwsh -c x', 'wsl ls', 'env make', 'FOO=1 env ls', 'xargs rm', 'eval x', 'exec make', 'sudo make', 'start notepad', 'nohup make', 'timeout 5 make', '/usr/bin/bash -lc x', 'C:/Git/bin/bash.exe -c x',
    'node -e 1', 'node -p 1', 'node --eval=1', 'node -pe 1', 'node --input-type=module -e 1', 'python -c 1', 'python3 -c 1', 'py -3 -c 1', 'python -Bc 1', 'python3.12 -c 1', 'ruby -e 1', 'perl -e 1', 'perl -ne 1', 'deno eval 1', 'bun -e 1', 'ls && bash -c x', 'make; node -e 1', 'cat x | sh']
  same(escapes.filter((c) => !G.isShellEscape(c)), [], 'isShellEscape: every shell, wrapper and inline-code interpreter, in any command of the line')
  same(escapes.map((command) => G.grantPatternOf({ tool: 'Bash', input: { command } })).filter((r) => r.length), [], 'an escape denial grants nothing')
  same(['PowerShell', 'Bash'].map((tool) => G.grantPatternOf({ tool, input: { command: 'cmd /c del x' } })), [[], []], 'through either shell tool')
  const escRules = ['Bash(bash -c:*)', 'Bash(bash)', 'Bash(env FOO=1:*)', 'Bash(xargs -n1:*)', 'Bash(node -e:*)', 'Bash(node --inspect:*)', 'Bash(python -m:*)', 'Bash(python3 -c)', 'Bash(timeout 5:*)', 'Bash(sudo make:*)', 'Bash(deno eval:*)', 'Bash(cmd /c:*)']
  check(!escRules.some(G.isGrantable), 'isGrantable refuses a shell or escape rule, and an interpreter prefix that ends in an option (an inline code flag could follow)', escRules.filter(G.isGrantable))
  const notEscapes = ['node script.js', 'node --inspect app.js', 'python3 setup.py test', 'python -m pytest -q', 'ruby app.rb', 'perl x.pl', 'deno run main.ts', 'bun run dev', 'npm test', 'git log', 'make all', 'shellcheck x.sh', 'environment x']
  same(notEscapes.filter(G.isShellEscape), [], 'isShellEscape leaves a script run, a module run and other programs')
  // Quoted text, a comment and a heredoc body are data: a commit message never reads as `start page` or `Time out`.
  const commit = "git commit -m \"$(cat <<'EOF'\nFix the header\n\nStart the server on boot; env vars too\nEOF\n)\""
  const quoted = ['git commit -m "Fix the header & start page"', 'git commit -m "Title\n\nTime out after 5 s"', commit, "echo 'a; bash -c x'", "cat <<'EOF'\n$(sh -c x)\nEOF", 'ls -la # then; bash -c x', 'git log --format="%h | sh"']
  same(quoted.filter(G.isShellEscape), [], 'isShellEscape: quoted text, a comment and a quoted heredoc body are data, never a command')
  same([G.grantPatternOf({ tool: 'Bash', input: { command: commit } }), grantOf('git commit -m Fix')], [[], ['Bash(git commit -m Fix)']], 'so a denied commit with such a message is no escape; off the allowlist it grants only the exact rule of a one-line command of plain words')
  const subs = ['echo "$(bash -c x)"', 'echo `sh -c x`', 'x=$(bash)', '(bash -c x)', 'cat <<EOF\n$(sh -c x)\nEOF', 'bash <<EOF\nls\nEOF', "npm test # don't\nbash -c x", 'npm test \\\n && bash -c x', 'echo "a" | sh', 'git commit -m "$(cat x)" && sh -c y']
  same(subs.filter((c) => !G.isShellEscape(c)), [], 'a command substitution (also in double quotes or an unquoted heredoc), a subshell and the line after a comment are commands')
  check(G.isGrantable('Bash(node script.js:*)') && G.isGrantable('Bash(python setup.py:*)') && G.isGrantable('Bash(python3 setup.py test)') && G.isGrantable('Bash(deno run main.ts)'), 'an interpreter running a script or a subcommand stays grantable (its prefix on the allowlist, else its exact rule)')
  same(G.grantPatternOf({ tool: 'Bash', input: { command: 'npm test -- --watch' } }), ['Bash(npm test:*)'], 'a Bash denial: the Bash rule of its allowlist row, never a PowerShell twin (B5, E10 SPIKE)')
  same([G.grantPatternOf({ tool: 'PowerShell', input: { command: 'Get-ChildItem src' } }), grantOf('npm run lint\nmore', 'PowerShell'), grantOf('Get-ChildItem src\nmore', 'PowerShell')], [['Bash(Get-ChildItem src)'], ['Bash(npm run:*)'], []], 'a PowerShell denial: its Bash rule only (npm.cmd and the like re-parse %* in cmd.exe), first line only; off the allowlist on more lines: nothing')
  same(G.grantPatternOf({ tool: 'PowerShell', input: { command: 'npm test x&calc' } }), ['Bash(npm test:*)'], 'the x&calc case: never PowerShell(npm test:*)')
  same(G.grantPatternOf({ tool: 'Bash', input: { command: 'ls | grep x' } }), [], 'the words stop at a pipe: a one-word program before it grants nothing (never Bash(ls:*))')
  same([G.grantPatternOf({ tool: 'Bash', input: { command: 'ls src | grep x' } }), grantOf('git status --short | tail -1'), grantOf('git diff --stat | tail -1')], [[], ['Bash(git status:*)'], []], 'before a pipe: a program off the allowlist grants nothing (never Bash(ls src:*)), a row its prefix')
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
  same(names, ['show', 'tasks', 'task.get', 'diff', 'log', 'task.create', 'task.update', 'comment', 'note', 'ask', 'needs', 'plan', 'review', 'verdict', 'done', 'approve', 'hire'], 'the 15 tools of 5.3 and team diff and log (fourth round), in order')
  check(K.TEAM_TOOLS.every((t) => t.method === `team.${t.name}`) && json(K.TEAM_CTL_METHODS) === json(K.TEAM_TOOLS.map((t) => t.method)), 'method = team.<name>; TEAM_CTL_METHODS follows the table')
  check(K.TEAM_CTL_METHODS.every((m) => P.CTL_METHODS.includes(m)), 'every team method is in CTL_METHODS (the server lets it reach the handler)')
  same(K.TEAM_TOOLS.filter((t) => !t.write).map((t) => t.name), ['show', 'tasks', 'task.get', 'diff', 'log'], 'reads: show, tasks, task get, diff, log')
  same(K.TEAM_TOOLS.filter((t) => t.terminal).map((t) => [t.name, t.terminal]), [['ask', 'ask'], ['needs', 'needs'], ['plan', 'plan'], ['review', 'review'], ['verdict', 'verdict'], ['done', 'done'], ['approve', 'approvePlan'], ['hire', 'hire']], 'terminals and their TerminalTool')
  check(K.TEAM_TOOLS.every((t) => t.usage.startsWith(`snaos team ${t.name.replace('.', ' ')}`) && t.summary.length > 0 && !DASH_RE.test(t.usage + t.summary)), 'every usage is its CLI line; summaries English without dashes')
  check(K.teamTool('team.plan').terminal === 'plan' && K.teamTool('team.nope') === null && K.teamTool('plan') === null, 'teamTool by method')
  check(K.isTeamMethod('team.show') && !K.isTeamMethod('ping') && !K.isTeamMethod('team.') && !K.isTeamMethod('team.task'), 'isTeamMethod')

  const ok = (kind, name, mode, extra = {}) => K.allowedFor(kind, K.teamTool(`team.${name}`), { mode, hasTask: mode !== 'lead' && mode !== 'free', ...extra })
  check(['lead', 'dev', 'qa', 'research', 'custom'].every((k) => ['plan', 'exec', 'qa', 'lead', 'free'].every((m) => ok(k, 'show', m) && ok(k, 'tasks', m) && ok(k, 'task.get', m) && ok(k, 'diff', m) && ok(k, 'log', m) && ok(k, 'comment', m) && ok(k, 'ask', m) && ok(k, 'needs', m))), 'reads (team diff and log too), comment, ask and needs: every role, every mode')
  check(ok('lead', 'task.create', 'lead') && ok('dev', 'task.create', 'exec') && ok('custom', 'task.create', 'exec'), 'task create: the Lead, and a Dev or custom role in exec')
  check(!ok('dev', 'task.create', 'plan') && !ok('dev', 'task.create', 'exec', { hasTask: false }) && !ok('qa', 'task.create', 'qa') && !ok('research', 'task.create', 'exec') && !ok('dev', 'task.create', 'lead'), 'task create: never from a plan run, without a task, QA or research')
  check(ok('lead', 'task.update', 'lead') && !ok('dev', 'task.update', 'exec') && ok('lead', 'note', 'lead') && ok('lead', 'note', 'free') && !ok('dev', 'note', 'free'), 'task update and note: the Lead only')
  check(ok('dev', 'plan', 'plan') && ok('research', 'plan', 'plan') && ok('custom', 'plan', 'plan') && !ok('dev', 'plan', 'exec') && !ok('qa', 'plan', 'plan') && !ok('lead', 'plan', 'lead'), 'plan: dev, research and custom in plan runs')
  check(ok('dev', 'review', 'exec') && ok('custom', 'review', 'exec') && !ok('dev', 'review', 'plan') && !ok('research', 'review', 'exec'), 'review: dev and custom in exec')
  check(ok('qa', 'verdict', 'qa') && !ok('qa', 'verdict', 'exec') && !ok('dev', 'verdict', 'qa'), 'verdict: QA in qa runs')
  check(ok('research', 'done', 'plan') && ok('research', 'done', 'exec') && ok('custom', 'done', 'exec') && !ok('custom', 'done', 'plan'), 'done: research in plan or exec, custom in exec')
  check(ok('dev', 'done', 'exec', { isolation: 'main' }) && !ok('dev', 'done', 'exec', { isolation: 'worktree' }) && !ok('dev', 'done', 'exec') && !ok('qa', 'done', 'qa') && !ok('lead', 'done', 'lead'), 'done: a writing Dev only with isolation main')
  // Decision 24 (B4 integration item 4): a Dev whose ROLE is readonly runs its worktree task in the repo root and commits
  // nothing: its exec run ends with done (never review). A writing Dev's plan run is readonly for its phase only.
  check(ok('dev', 'done', 'exec', { isolation: 'worktree', profile: 'readonly' }) && ok('custom', 'done', 'exec', { isolation: 'worktree', profile: 'readonly' }), 'done: the exec run of a readonly Dev or custom role, worktree task too')
  check(!ok('dev', 'done', 'plan', { isolation: 'worktree', profile: 'readonly' }) && !ok('dev', 'done', 'exec', { isolation: 'worktree', profile: 'total' }) && !ok('dev', 'done', 'exec', { isolation: 'worktree', profile: 'custom' }), 'done: never a writing Dev\'s plan run (readonly for its phase) nor its exec run in a worktree')
  check(!ok('dev', 'review', 'exec', { profile: 'readonly' }) && !ok('custom', 'review', 'exec', { profile: 'readonly' }) && ok('dev', 'review', 'exec', { profile: 'total' }) && ok('custom', 'review', 'exec', { profile: 'custom' }), 'review: never a readonly exec run (nothing committed to review)')
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
  console.log(`PASS: ${checks} tree-kill checks (real grandchild tree kill, procStartTime, childrenSince, taskkill and kill fakes, agentCli, spawnTarget, teamArgv snapshots, grants, teamTools, guide, channel text, parseTeamBlock)`)
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
