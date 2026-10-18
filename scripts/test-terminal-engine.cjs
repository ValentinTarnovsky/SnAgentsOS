// Terminal engine (E6): ModeTracker, replay hygiene, the exit frame and the
// default shell resolution, against the real main-process modules with a fake
// node-pty. xterm and its addons are pinned exact: a bump must pass this suite.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const os = require('node:os')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'ws', 'node-pty'], alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval, ...overrides })
  return mod.exports
}

// --- pinned versions -------------------------------------------------------
{
  const pkg = require(path.join(root, 'package.json'))
  check(pkg.dependencies['@xterm/xterm'] === '5.5.0', '@xterm/xterm pinned exact at 5.5.0 (never move to 6)')
  check(pkg.dependencies['@xterm/addon-canvas'] === '0.7.0', '@xterm/addon-canvas pinned exact at 0.7.0')
  check(pkg.dependencies['@xterm/addon-unicode11'] === '0.8.0', '@xterm/addon-unicode11 pinned exact at 0.8.0')
}

// --- ModeTracker (E6-FR-33) -------------------------------------------------
const { ModeTracker } = load('src/main/pty/ModeTracker.ts')
{
  const t = new ModeTracker()
  check(t.rehydrate() === '' && t.altScreen === false, 'fresh tracker has nothing to rehydrate')
  t.feed('hello \x1b[?2004h world \x1b[?25l')
  check(t.rehydrate() === '\x1b[?25l\x1b[?2004h', 'simple DECSET/DECRST modes tracked')
  t.feed('\x1b[?25h\x1b[?2004l')
  check(t.rehydrate() === '', 'resetting returns to defaults')
  t.feed('\x1b[?1000;1006h')
  check(t.rehydrate() === '\x1b[?1000h\x1b[?1006h', 'parameter lists set every listed mode')
  t.feed('\x1b[?1002h')
  check(t.rehydrate() === '\x1b[?1002h\x1b[?1006h', 'a new mouse protocol replaces the previous one')
  t.feed('\x1b[?1000l')
  check(t.rehydrate() === '\x1b[?1006h', 'resetting any mouse protocol clears the active one (xterm.js)')
  t.feed('\x1b[?1006l')
  check(t.rehydrate() === '', 'encoding reset')
}
{
  const t = new ModeTracker()
  t.feed('\x1b[?10'); t.feed('06h')
  check(t.rehydrate() === '\x1b[?1006h', 'a sequence split across chunks is registered')
  const seq = '\x1b[?1;9;1004;1015h'
  for (const ch of seq) t.feed(ch)
  check(t.rehydrate() === '\x1b[?1h\x1b[?9h\x1b[?1015h\x1b[?1006h\x1b[?1004h', 'byte-by-byte feeding gives the same state')
  t.feed('\x1b'); t.feed('c')
  check(t.rehydrate() === '', 'RIS split across chunks resets everything')
}
{
  const t = new ModeTracker()
  t.feed('\x1b[?1049h\x1b[?1049l')
  check(!t.altScreen && t.rehydrate() === '', '?1049h then ?1049l in one chunk ends inactive')
  t.feed('\x1b[?1000h\x1b[?2004h\x1b[?1049h')
  check(t.altScreen && t.rehydrate().startsWith('\x1b[?1049h'), 'alt screen is rehydrated first')
  t.feed('\x1b[?25l\x1b[!p')
  check(t.rehydrate() === '\x1b[?1049h\x1b[?1000h', 'DECSTR resets cursor/paste modes but keeps mouse and alt (xterm.js)')
  t.feed('\x1bc')
  check(!t.altScreen && t.rehydrate() === '', 'RIS clears alt screen and mouse')
}
{
  const t = new ModeTracker()
  t.feed('\x1b[?' + '1'.repeat(40) + 'h\x1b[?2004h')
  check(t.rehydrate() === '\x1b[?2004h', 'an oversized parameter list is dropped without breaking the next sequence')
  t.feed('\x1b[?1000\x1b[?1006h')
  check(t.rehydrate() === '\x1b[?1006h\x1b[?2004h', 'ESC inside a sequence restarts parsing')
  t.feed('\x1b[1000h\x1b[38;2;1;2;3m\x1b]0;?1000h\x07')
  check(t.rehydrate() === '\x1b[?1006h\x1b[?2004h', 'non-private CSI, SGR and OSC text are ignored')
  t.feed('\x1b[?1000$p')
  check(!t.rehydrate().includes('1000h'), 'DECRQM is not a mode change')
}
{
  const t = new ModeTracker()
  const line = 'x'.repeat(70) + '\x1b[38;2;10;20;30mcolor\x1b[0m\r\n'
  const chunk = line.repeat(Math.ceil(65536 / line.length)).slice(0, 65536)
  for (let i = 0; i < 20; i++) t.feed(chunk)
  const start = process.hrtime.bigint()
  const rounds = 50
  for (let i = 0; i < rounds; i++) t.feed(chunk)
  const perFlushMs = Number(process.hrtime.bigint() - start) / 1e6 / rounds
  console.log(`  ModeTracker: ${perFlushMs.toFixed(3)} ms per 64 KB flush (budget 0.2 ms)`)
  // CI machines vary; the hard gate is loose, the budget is printed above.
  check(perFlushMs < 2, 'ModeTracker stays far below 2 ms per 64 KB flush')
}

// --- replay hygiene ---------------------------------------------------------
const { sanitizeQueries } = load('src/main/pty/ansiSanitize.ts')
{
  const raw = 'a\x1b[c b\x1b[0c c\x1b[>c d\x1b[>0c e\x1b[=c f\x1b[6n g\x1b[5n h\x1b[?6n i\x1b[14t j\x1b[18;0;0t k\x1b[?2004$p l\x1b[>q m\x1b[?u n'
  check(sanitizeQueries(raw) === 'a b c d e f g h i j k l m n', 'DA1/DA2/DA3, DSR, window reports, DECRQM, XTVERSION and kitty queries are removed')
  const keep = '\x1b[?25l\x1b[38;2;255;0;0mred\x1b[0m\x1b[2J\x1b[H\x1b[?1049h\x1b[>1u\x1b]0;title\x07'
  check(sanitizeQueries(keep) === keep, 'SGR, modes, cursor moves, kitty push and OSC are kept')
}
let current = null
const loaded = load('src/main/pty/PtyManager.ts', {
  require: id => id === 'node-pty' ? { spawn: (...a) => current.impl(...a) } : id === 'electron' ? { app: { getPath: () => os.tmpdir() } } : require(id),
  console: { ...console, warn() {} },
})
const { trimRingHead } = loaded
{
  check(trimRingHead('abc', false) === 'abc', 'an untruncated ring is the stream start and stays whole')
  check(trimRingHead(';2;255mjunk\r\nline two', true) === 'line two', 'a truncated head mid-escape starts after the first line break')
  const crOnly = '5mtail\r\x1b[2Kframe 1\r\x1b[2Kframe 2'
  check(trimRingHead(crOnly, true) === '\x1b[2Kframe 1\r\x1b[2Kframe 2', 'a ring without line breaks starts at the first ESC, not empty')
  const noBoundary = 'z'.repeat(9000) + '\n' + 'rest'
  check(trimRingHead(noBoundary, true) === noBoundary, 'no boundary near the head keeps the ring rather than dropping it')
}

// --- PtyManager with a fake node-pty ------------------------------------------
function fakeHarness() {
  const procs = []
  const sent = []
  const spawnCalls = []
  const impl = (shell, args, opts) => {
    spawnCalls.push({ shell, args, opts })
    const dataCbs = [], exitCbs = []
    const proc = {
      cols: opts.cols, rows: opts.rows, writes: [], killed: false,
      onData: cb => dataCbs.push(cb), onExit: cb => exitCbs.push(cb),
      write: d => proc.writes.push(d), resize: (c, r) => { proc.cols = c; proc.rows = r },
      pause() {}, resume() {},
      // Worst case for the natural flag: killing fires onExit synchronously.
      kill: () => { proc.killed = true; proc.exit(1) },
      emit: d => dataCbs.forEach(cb => cb(d)),
      exit: code => exitCbs.forEach(cb => cb({ exitCode: code })),
    }
    procs.push(proc)
    return proc
  }
  return { impl, procs, sent, spawnCalls }
}
function manager() {
  current = fakeHarness()
  const pm = new loaded.PtyManager(() => ({ isDestroyed: () => false, send: (ch, p) => current.sent.push({ ch, p }) }))
  return { pm, h: current }
}
const flushAll = () => new Promise(r => setTimeout(r, 30))

async function main() {
  // Spawn result + shell resolution wiring (E6-FR-32).
  {
    const { pm, h } = manager()
    const res = pm.spawn({ paneId: 'p1', cols: 80, rows: 24 })
    check(typeof res.ptyId === 'string' && ['powershell', 'posix', 'other', 'cmd'].includes(res.shellKind) && !res.warning, 'spawn without a shell uses the OS default, no warning')
    const missing = process.platform === 'win32' ? 'C:\\snaos-nope\\noexiste.exe' : '/snaos-nope/noexiste'
    const bad = pm.spawn({ paneId: 'p2', shell: missing, cols: 80, rows: 24 })
    check(bad.warning && bad.warning.kind === 'shellNotFound' && bad.warning.requested === missing, 'a missing configured shell reports shellNotFound')
    check(h.spawnCalls[1].shell === bad.warning.used && h.spawnCalls[1].shell !== missing, 'the default shell is what actually gets spawned')
    const real = pm.spawn({ paneId: 'p3', shell: process.execPath, cols: 80, rows: 24 })
    check(!real.warning && h.spawnCalls[2].shell === process.execPath && real.shellKind === 'other', 'an existing absolute shell is used as is')
    pm.killAll()
  }

  // Modes survive the ring (E6-FR-33 / FR-05): emitted before 300 KB of output.
  {
    const { pm, h } = manager()
    const { ptyId } = pm.spawn({ paneId: 'pane', cols: 100, rows: 30 })
    const proc = h.procs[0]
    proc.emit('\x1b[?1000h\x1b[?1006h\x1b[?2004h\x1b[?25l\x1b[c')
    const line = '\x1b[38;2;200;100;50m' + 'y'.repeat(60) + '\x1b[0m\r\n'
    for (let i = 0; i < 4000; i++) proc.emit(line)
    proc.emit('tail\x1b[6n')
    await flushAll()
    const rep = pm.getReplay('pane')
    check(rep.ptyId === ptyId && rep.cols === 100 && rep.rows === 30, 'getReplay keeps id and live size')
    const prefix = '\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[?2004h'
    check(rep.replay.startsWith(prefix), 'replay starts with the modes that scrolled out of the ring')
    const body = rep.replay.slice(prefix.length)
    check(!body.includes('?1000h'), 'the original DECSET really left the 256 KB ring (fixture is meaningful)')
    check(body.startsWith('\x1b[38;2;200;100;50m'), 'a truncated ring head starts on a clean line, no `;2;...m` text')
    check(!body.includes('\x1b[6n') && body.endsWith('tail'), 'queries in the ring are stripped from the replay')
    const re = pm.reattach('pane')
    check(re.replay === rep.replay, 'desktop reattach gets the same replay as phones')
    pm.killAll()
  }
  {
    const { pm, h } = manager()
    pm.spawn({ paneId: 'alt', cols: 80, rows: 24 })
    h.procs[0].emit('\x1b[?1049h\x1b[?1002h')
    for (let i = 0; i < 3000; i++) h.procs[0].emit('\x1b[H' + 'w'.repeat(100) + '\r\n')
    await flushAll()
    check(pm.getReplay('alt').replay.startsWith('\x1b[?1049h\x1b[?1002h'), 'alt screen comes first in the rehydration')
    pm.killAll()
  }

  // The exit frame (E6-FR-34) through the real SessionManager sink.
  {
    const { pm, h } = manager()
    const { SessionManager } = load('src/main/remote/SessionManager.ts', { setInterval: () => 0, clearInterval() {} })
    const sm = new SessionManager({ ptyManager: pm })
    const frames = []
    const session = { ws: { readyState: 1, send: s => frames.push(JSON.parse(s)), bufferedAmount: 0 }, authed: true, subs: new Set(), outBuf: new Map(), outTimer: null, congested: new Set(), congestedSince: new Map(), lastSeen: Date.now() }
    const statusExits = []
    pm.addSink(sm)
    pm.addSink({ id: 'status', onSpawn() {}, onData() {}, onExit: (ptyId, paneId, code, info) => statusExits.push({ ptyId, code, ...info }) })
    pm.spawn({ paneId: 'pane', cols: 80, rows: 24 })
    h.procs[0].emit('\x1b[?1000h$ ')
    await flushAll()
    sm.handleSub(session, 'pane')
    const replay = frames.find(f => f.type === 'replay')
    check(replay && replay.running && replay.data.startsWith('\x1b[?1000h'), 'phone replay carries the mouse mode rehydration')
    h.procs[0].emit('bye\r\n')
    h.procs[0].exit(3)
    const exits = frames.filter(f => f.type === 'exit')
    check(exits.length === 1 && exits[0].exitCode === 3 && exits[0].paneId === 'pane', 'a natural exit of the live pty sends exactly one exit frame')
    const outIdx = frames.findIndex(f => f.type === 'out' && f.data.includes('bye'))
    check(outIdx >= 0 && outIdx < frames.indexOf(exits[0]), 'the final output is flushed before the exit frame')
    check(statusExits.at(-1).natural && statusExits.at(-1).current && statusExits.at(-1).code === 3, 'status sink sees the natural exit')

    pm.spawn({ paneId: 'pane', cols: 80, rows: 24 })
    pm.kill(pm.ptyIdForPane('pane'))
    check(frames.filter(f => f.type === 'exit').length === 1, 'kill (fake pty exits synchronously inside kill) sends no exit frame')
    check(statusExits.at(-1).natural === false && statusExits.at(-1).current === true, 'status sink still gets the killed exit to release integrations')

    // A stale pty: the pane rebound to a newer pty, then the old one dies on its own.
    pm.spawn({ paneId: 'pane', cols: 80, rows: 24 })
    const old = h.procs.at(-1)
    pm.spawn({ paneId: 'pane', cols: 80, rows: 24 })
    old.exit(0)
    check(frames.filter(f => f.type === 'exit').length === 1, 'a stale pty exit is not current and sends nothing')
    check(statusExits.at(-1).current === false && statusExits.at(-1).natural === true, 'status sink gets the stale exit flagged not current')
    pm.killAll()
    check(frames.filter(f => f.type === 'exit').length === 1, 'killAll (app quit / close) sends no exit frame')
  }
  {
    const failing = load('src/main/pty/PtyManager.ts', {
      require: id => id === 'node-pty' ? { spawn: () => { throw new Error('boom') } } : id === 'electron' ? { app: { getPath: () => os.tmpdir() } } : require(id),
      console: { ...console, warn() {} },
    })
    const pm = new failing.PtyManager(() => null)
    const seen = []
    pm.addSink({ id: 's', onSpawn() {}, onData() {}, onExit: (_p, _pane, code, info) => seen.push({ code, ...info }) })
    assert.throws(() => pm.spawn({ paneId: 'x', cols: 80, rows: 24 }))
    check(seen.length === 1 && seen[0].code === -1 && !seen[0].current && !seen[0].natural, 'a failed spawn notifies sinks with { current: false, natural: false }')
  }

  // resolveShell (E6-FR-32).
  {
    const { resolveShell, shellKindOf, shellExists } = load('src/main/pty/shellResolve.ts')
    const files = new Set(['C:\\Tools\\pwsh.exe', 'C:\\Win\\System32\\cmd.exe', '/usr/bin/fish'])
    const isFile = p => files.has(p)
    const win = { platform: 'win32', env: { Path: 'C:\\Win\\System32;"C:\\Tools"', PATHEXT: '.COM;.EXE;.BAT' }, isFile }
    const r1 = resolveShell('C:\\nope\\pwsh.exe', 'powershell.exe', win)
    check(r1.shell === 'powershell.exe' && r1.warning && r1.warning.requested === 'C:\\nope\\pwsh.exe' && r1.warning.used === 'powershell.exe', 'nonexistent absolute path falls back with a warning')
    const r2 = resolveShell('noexiste.exe', 'powershell.exe', win)
    check(r2.shell === 'powershell.exe' && r2.warning && r2.warning.kind === 'shellNotFound', 'a name not in PATH falls back with a warning')
    const r3 = resolveShell('pwsh', 'powershell.exe', win)
    check(r3.shell === 'pwsh' && !r3.warning && r3.shellKind === 'powershell', 'a bare name found via PATH + PATHEXT (quoted PATH entry) is used')
    check(resolveShell('cmd.exe', 'powershell.exe', win).shellKind === 'cmd', 'cmd.exe in PATH resolves with kind cmd')
    check(resolveShell('"C:\\Tools\\pwsh.exe"', 'powershell.exe', win).shell === 'C:\\Tools\\pwsh.exe', 'surrounding quotes are stripped')
    const r4 = resolveShell('   ', 'powershell.exe', win)
    check(r4.shell === 'powershell.exe' && !r4.warning, 'an empty setting means the OS default, silently')
    const posix = { platform: 'linux', env: { PATH: '/usr/bin:/bin' }, isFile }
    check(resolveShell('fish', '/bin/bash', posix).shell === 'fish', 'POSIX name lookup in PATH')
    check(resolveShell('/opt/zsh', '/bin/bash', posix).warning?.used === '/bin/bash', 'POSIX missing absolute path falls back')
    check(!shellExists('fish.exe', posix), 'no PATHEXT guessing on POSIX')
    check(shellKindOf('C:\\Program Files\\PowerShell\\7\\pwsh.exe') === 'powershell' && shellKindOf('/bin/zsh') === 'posix' && shellKindOf('wsl.exe') === 'posix' && shellKindOf('node') === 'other', 'shellKindOf by executable name')
    check(resolveShell(process.execPath, 'x').shell === process.execPath, 'real filesystem lookup finds an existing executable')
  }

  console.log(`PASS: ${checks} terminal engine checks`)
}
main().catch(e => { console.error(e); process.exit(1) })
